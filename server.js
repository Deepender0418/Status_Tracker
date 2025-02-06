const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');
const { Telegraf } = require('telegraf');

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 10000,
        });
        console.log('✅ MongoDB Connected');
    } catch (error) {
        console.error('❌ MongoDB Connection Error:', error);
        process.exit(1);
    }
};

connectDB();

const app = express();
app.use(cors());
app.use(express.json());

const userSchema = new mongoose.Schema({
    username: { type: String, required: true },
    steamId: { type: String, required: true },
    steamStatus: { type: String, enum: ['online', 'offline'], default: 'offline' },
    statusHistory: [
        {
            status: { type: String, enum: ['online', 'offline'], required: true },
            date: { type: String, required: true },
            time: { type: String, required: true }
        }
    ]
});

const User = mongoose.model('User', userSchema);

const resolveSteamId = async (url) => {
    try {
        const profileRegex = /\/profiles\/([^\/]+)/;
        const idRegex = /\/id\/([^\/]+)/;
        
        if (profileRegex.test(url)) {
            return url.match(profileRegex)[1];
        } else if (idRegex.test(url)) {
            const vanityName = url.match(idRegex)[1];
            const response = await axios.get(
                `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/`,
                { params: { key: process.env.STEAM_API_KEY, vanityurl: vanityName } }
            );
            if (response.data.response.success === 1) {
                return response.data.response.steamid;
            }
            throw new Error('Vanity URL resolution failed');
        }
        throw new Error('Invalid Steam profile URL format');
    } catch (error) {
        console.error('❌ Error resolving Steam ID:', error);
        return null;
    }
};

const getCurrentDateTime = () => {
    const now = new Date();
    return {
        date: now.toISOString().split('T')[0],
        time: new Intl.DateTimeFormat('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        }).format(now)
    };
};

const sendTelegramMessage = async (message) => {
    try {
        await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, message);
        console.log('📩 Telegram message sent:', message);
    } catch (error) {
        console.error('❌ Error sending Telegram message:', error);
    }
};

let steamId, steamUsername, monitoringInterval = null;
let isMonitoringActive = false;

const fetchUsername = async () => {
    try {
        const response = await axios.get(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/`, {
            params: { key: process.env.STEAM_API_KEY, steamids: steamId }
        });

        const player = response.data?.response?.players?.[0];
        return player?.personaname || 'Tracked User';
    } catch (error) {
        console.error('❌ Error fetching username:', error);
        return 'Tracked User';
    }
};

const monitorStatus = async () => {
    try {
        const response = await axios.get(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/`, {
            params: { key: process.env.STEAM_API_KEY, steamids: steamId }
        });

        const player = response.data?.response?.players?.[0];
        if (!player) return;

        let user = await User.findOne({ steamId });
        if (!user) return;

        const steamStatus = player.personastate === 1 ? 'online' : 'offline';

        if (user.steamStatus !== steamStatus) {
            const { date, time } = getCurrentDateTime();

            user.statusHistory.push({ status: steamStatus, date, time });
            user.steamStatus = steamStatus;
            await user.save();

            console.log(`🔵 User: ${steamUsername} is now ${steamStatus} at ${date} ${time}`);

            const message = steamStatus === "offline"
                ? `jaa rahi hu me OFFLINE, aye bade😤`
                : `Aa gyi ONLINE, Tumhare sath nhi khelungi, aye bade😤`;

            sendTelegramMessage(message);
        }
    } catch (error) {
        console.error('❌ Error monitoring status:', error);
    }
};

const startMonitoring = async () => {
    if (!isMonitoringActive) {
        monitoringInterval = setInterval(monitorStatus, 5000);
        isMonitoringActive = true;
        console.log('✅ Monitoring started');

        // Check last saved status and send notification if changed
        let user = await User.findOne({ steamId });
        if (user) {
            const response = await axios.get(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/`, {
                params: { key: process.env.STEAM_API_KEY, steamids: steamId }
            });

            const player = response.data?.response?.players?.[0];
            if (player) {
                const currentStatus = player.personastate === 1 ? 'online' : 'offline';

                if (user.steamStatus !== currentStatus) {
                    const { date, time } = getCurrentDateTime();

                    user.statusHistory.push({ status: currentStatus, date, time });
                    user.steamStatus = currentStatus;
                    await user.save();

                    console.log(`🔵 User: ${steamUsername} is now ${currentStatus} at ${date} ${time}`);

                    const message = currentStatus === "offline"
                        ? `jaa rahi hu me OFFLINE, aye bade😤`
                        : `Aa gyi ONLINE, Tumhare sath nhi khelungi, aye bade😤`;

                    sendTelegramMessage(message);
                }
            }
        }
    }
};

const stopMonitoring = () => {
    if (isMonitoringActive) {
        clearInterval(monitoringInterval);
        isMonitoringActive = false;
        console.log('⛔ Monitoring stopped');
    }
};

bot.command('status', async (ctx) => {
    ctx.reply(`📊 Tracking is ${isMonitoringActive ? '✅ ACTIVE' : '❌ STOPPED'}`);
});

bot.command('start', (ctx) => {
    startMonitoring();
    ctx.reply('✅ Tracking started.');
});

bot.command('stop', (ctx) => {
    stopMonitoring();
    ctx.reply('⛔ Tracking stopped.');
});

bot.launch();
console.log('🤖 Telegram Bot is running...');

const init = async () => {
    steamId = await resolveSteamId(process.env.STEAM_PROFILE_URL);
    if (!steamId) return console.error('❌ Failed to resolve Steam ID.');
    steamUsername = await fetchUsername();
    startMonitoring();
};

init();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
