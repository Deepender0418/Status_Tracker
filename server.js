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
    telegramId: { type: Number, required: true, unique: true },
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

userSchema.index({ steamId: 1 });

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

const fetchWithRetry = async (url, params, retries = 3) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.get(url, { params });
            return response.data;
        } catch (error) {
            console.error(`❌ API Error (Attempt ${attempt}):`, error.message);
            if (attempt === retries) throw error;
            await new Promise(res => setTimeout(res, 3000)); 
        }
    }
};

let lastMessageTime = 0;
const COOLDOWN = 30 * 1000;
const sendTelegramMessage = async (message) => {
    if (Date.now() - lastMessageTime < COOLDOWN) return;
    lastMessageTime = Date.now();
    
    try {
        await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, `*${message}*`, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('❌ Error sending Telegram message:', error);
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

const monitorStatus = async () => {
    const users = await User.find({});
    
    for (const user of users) {
        try {
            const response = await fetchWithRetry(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/`, {
                key: process.env.STEAM_API_KEY,
                steamids: user.steamId
            });

            const player = response?.response?.players?.[0];
            if (!player) continue;

            const steamStatus = player.personastate === 1 ? 'online' : 'offline';

            if (user.steamStatus !== steamStatus) {
                const { date, time } = getCurrentDateTime();
                user.statusHistory.push({ status: steamStatus, date, time });
                user.steamStatus = steamStatus;
                await user.save();

                sendTelegramMessage(`🔵 *${user.username}* is now *${steamStatus.toUpperCase()}* at ${date} ${time}`);
            }
        } catch (error) {
            console.error(`❌ Error monitoring ${user.username}:`, error);
        }
    }
};

let monitoringInterval = null;
let isMonitoringActive = false;

const startMonitoring = () => {
    if (isMonitoringActive) {
        console.log('⚠️ Monitoring is already active.');
        return;
    }
    monitoringInterval = setInterval(monitorStatus, 5000);
    isMonitoringActive = true;
    console.log('✅ Monitoring started');
};

const stopMonitoring = () => {
    if (isMonitoringActive) {
        clearInterval(monitoringInterval);
        isMonitoringActive = false;
        console.log('⛔ Monitoring stopped');
    }
};

bot.command('start', async (ctx) => {
    const telegramId = ctx.from.id;
    const existingUser = await User.findOne({ telegramId });

    if (!existingUser) {
        return ctx.reply('❌ You are not registered. Please provide your Steam profile URL.');
    }

    startMonitoring();
    ctx.reply('✅ Tracking started.');
});

bot.command('stop', (ctx) => {
    stopMonitoring();
    ctx.reply('⛔ Tracking stopped.');
});

bot.command('restart', (ctx) => {
    stopMonitoring();
    setTimeout(() => startMonitoring(), 2000);
    ctx.reply('🔄 Tracking restarted.');
});

bot.command('status', async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user) return ctx.reply('❌ User not found');

    ctx.reply(`📊 *Status of ${user.username}:*\n- Steam: *${user.steamStatus.toUpperCase()}*\n- Tracking: ${isMonitoringActive ? '✅ ACTIVE' : '❌ STOPPED'}`, { parse_mode: 'Markdown' });
});

bot.command('register', async (ctx) => {
    const telegramId = ctx.from.id;
    const args = ctx.message.text.split(' ');

    if (args.length < 2) {
        return ctx.reply('❌ Please provide your Steam profile URL.\nExample: `/register https://steamcommunity.com/id/yourusername`', { parse_mode: 'Markdown' });
    }

    const steamProfileURL = args[1];
    const steamId = await resolveSteamId(steamProfileURL);
    if (!steamId) return ctx.reply('❌ Invalid Steam profile URL.');

    const steamUsername = 'Tracked User';

    let user = await User.findOne({ telegramId });
    if (!user) {
        user = new User({ telegramId, username: steamUsername, steamId, statusHistory: [] });
        await user.save();
        ctx.reply('✅ Registered successfully! Use /start to begin tracking.');
    } else {
        ctx.reply('ℹ️ You are already registered.');
    }
});

bot.launch();
console.log('🤖 Telegram Bot is running...');

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
