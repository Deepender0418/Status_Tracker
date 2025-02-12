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
        await mongoose.connect(process.env.MONGODB_URI);
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
        
        if (profileRegex.test(url)) return url.match(profileRegex)[1];
        if (idRegex.test(url)) {
            const vanityName = url.match(idRegex)[1];
            const response = await axios.get(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/`, {
                params: { key: process.env.STEAM_API_KEY, vanityurl: vanityName }
            });
            return response.data.response.success === 1 ? response.data.response.steamid : null;
        }
        throw new Error('Invalid Steam profile URL format');
    } catch (error) {
        console.error('❌ Error resolving Steam ID:', error);
        return null;
    }
};

let lastMessageTime = 0;
const COOLDOWN = 30 * 1000;
const sendTelegramMessage = async (message) => {
    if (Date.now() - lastMessageTime < COOLDOWN) return;
    lastMessageTime = Date.now();
    try {
        await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, message);
        console.log('📩 Telegram message sent:', message);
    } catch (error) {
        console.error('❌ Error sending Telegram message:', error);
    }
};

let steamId, steamUsername, lastKnownStatus = null;
let monitoringInterval = null;
let isMonitoringActive = false;

const fetchUsername = async () => {
    try {
        const response = await axios.get(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/`, {
            params: { key: process.env.STEAM_API_KEY, steamids: steamId }
        });
        return response.data?.response?.players?.[0]?.personaname || 'Tracked User';
    } catch (error) {
        console.error('❌ Error fetching username:', error);
        return 'Tracked User';
    }
};

const createUser = async () => {
    let user = await User.findOne({ steamId });
    if (!user) {
        try {
            await new User({ username: steamUsername, steamId, statusHistory: [] }).save();
            console.log('✅ User created successfully');
        } catch (error) {
            console.error('❌ Error creating user:', error);
        }
    } else {
        console.log('ℹ️ User already exists');
    }
};

const getCurrentDateTime = () => {
    const now = new Date();
    return {
        date: now.toISOString().split('T')[0],
        time: new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(now)
    };
};

const monitorStatus = async () => {
    try {
        const response = await axios.get(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/`, {
            params: { key: process.env.STEAM_API_KEY, steamids: steamId }
        });
        const player = response.data?.response?.players?.[0];
        if (!player) return;

        const steamStatus = player.personastate === 1 ? 'online' : 'offline';
        if (lastKnownStatus !== steamStatus) {
            lastKnownStatus = steamStatus;
            sendTelegramMessage(steamStatus === 'offline' ? "Jaa rahi hu me OFFLINE\naye bade😤" : "Aa gyi ONLINE\nTumhare sath nhi khelungi\naye bade😤");
        }
    } catch (error) {
        console.error('❌ Error monitoring status:', error);
    }
};

const startMonitoring = () => {
    if (isMonitoringActive) return;
    stopMonitoring();
    monitoringInterval = setInterval(monitorStatus, 5000);
    isMonitoringActive = true;
    console.log('✅ Monitoring started');
};

const stopMonitoring = () => {
    if (!isMonitoringActive) return;
    clearInterval(monitoringInterval);
    isMonitoringActive = false;
    console.log('⛔ Monitoring stopped');
};

bot.command('hola', (ctx) => ctx.reply(lastKnownStatus === 'offline' ? "Kya h\ngame me nhi hu\nBusy hu me\naye bade😤" : "Tumhari thoo!!!\ngame me hu me\naye bade😤"));
let count = 0;
let triggered = false;

bot.command('bati', async (ctx) => {
    let message;
    
    if (lastKnownStatus === 'offline') {
        message = "Bola to tha game me hu\nnhi kar sakti bati bati😤";
    } else {
        switch (count) {
            case 0:
                message = "Ale Ale\nBati Bati kalega mela bacha, huh!!\nnhi karugi";
                count++;
                break;
            case 1:
                message = "Chuppp😤";
                count++;
                break;
            case 2:
                message = "😤";
                count++;
                break;
            case 3:
                message = "😤😤😤😤\nab agar bola na\nLiplock kardungi";
                count++;
                break;
            default:
                message = "💋💋💋";
                if (!triggered) {
                    triggered = true;
                    setTimeout(() => {
                        count = 0;
                        triggered = false;
                        console.log("Counter reset after 60 seconds");
                    }, 60000);
                }
                break;
        }
    }

    ctx.reply(message);
});


bot.command('restart', (ctx) => {
    stopMonitoring();
    setTimeout(startMonitoring, 2000);
    ctx.reply('🔄 Monitoring restarted');
});

bot.launch();
console.log('🤖 Telegram Bot is running...');

app.get('/status', (req, res) => {
    ctx.reply("Meri Location loge!!! aye bade");
    res.json({ status: lastKnownStatus })
});

const init = async () => {
    steamId = await resolveSteamId(process.env.STEAM_PROFILE_URL);
    if (!steamId) return console.error('❌ Failed to resolve Steam ID.');
    steamUsername = await fetchUsername();
    await createUser();
    startMonitoring();
};
init();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

setInterval(() => axios.get(`${process.env.SERVER_URL}`).catch(() => console.log(lastKnownStatus === 'offline' ? "Offline" : "Online")), 60000);
