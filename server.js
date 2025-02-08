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

let lastMessageTime = 0;
const COOLDOWN = 30 * 1000;
const sendTelegramMessage = async (message) => {
    const now = Date.now();
    if (now - lastMessageTime < COOLDOWN) return;
    lastMessageTime = now;
    
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

        const player = response.data?.response?.players?.[0];
        return player?.personaname || 'Tracked User';
    } catch (error) {
        console.error('❌ Error fetching username:', error);
        return 'Tracked User';
    }
};

const createUser = async () => {
    let user = await User.findOne({ steamId });
    
    if (!user) {
        user = new User({ username: steamUsername, steamId, statusHistory: [] });
        try {
            await user.save();
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
        time: new Intl.DateTimeFormat('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        }).format(now)
    };
};

var status = false;

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
            const { date, time } = getCurrentDateTime();
            status = steamStatus === "offline" ? true : false;
            const message = status
            ? "Jaa rahi hu me OFFLINE\naye bade😤"
            : "Aa gyi ONLINE\nTumhare sath nhi khelungi\naye bade😤";
            sendTelegramMessage(message);
        }
    } catch (error) {
        console.error('❌ Error monitoring status:', error);
    }
};

const startMonitoring = () => {
    if (!isMonitoringActive) {
        monitoringInterval = setInterval(monitorStatus, 5000);
        isMonitoringActive = true;
        console.log('✅ Monitoring started');
    }
};

const stopMonitoring = () => {
    if (isMonitoringActive) {
        clearInterval(monitoringInterval);
        isMonitoringActive = false;
        console.log('⛔ Monitoring stopped');
    }
};

bot.command('hola', async (ctx) => {
    const m = status
                ? "Kya h\nBusy hu me\naye bade😤"
                : "Tumhari thoo!!!\ngame me hu me\naye bade😤";
    ctx.reply(m);
});
var count = 0;
var triggered = false;
bot.command('bati', async (ctx) => {
    var m;
    if(count === 0)
    {
        m = status
                ? "Ale Ale\nBati Bati kalega mela bacha, huh!!\nnhi karugi"
                : "Bola to tha game me hu\nnhi kar sakti bati bati😤";
        count++;
    }
    else if(count === 1)
    {
        m = "Chuppp😤";
        count++;
    }
    else if(count === 2)
    {
        m = "😤";
        count++;
    }
    else if(count === 3)
    {
        m = "😤😤😤😤\nab agar bola na\nLiplock kardungi";
        count++;
    }
    else 
    {
        m = "💋💋💋";
        if(triggered === false)
        {
            triggered = true;
        }
    }
    const msg = m;
    ctx.reply(msg);
    if(triggered === true)
    {
        setInterval(() => {
            count = 0
            triggered = false;
        }, 60000);
    }
});

bot.command('restart', (ctx) => {
    stopMonitoring();
    setTimeout(() => startMonitoring(), 2000);
    ctx.reply('🔄 Monitoring restarted');
});

bot.launch();
console.log('🤖 Telegram Bot is running...');

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

// Pinging system to prevent server from idling
setInterval(() => {
    const m = status ? "Offline" : "Online";
    axios.get(`${process.env.SERVER_URL}`).catch((err) => console.log(m))}, 60000);

