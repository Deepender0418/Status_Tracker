const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');
const { Telegraf } = require('telegraf');
const crypto = require('crypto');

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
    ],
    authToken: { type: String, unique: true }
});

const playerSchema = new mongoose.Schema({
    name: { type: String, unique: true },
    lastSeen: { type: Date, default: Date.now }
});
const Player = mongoose.model('Player', playerSchema);

const User = mongoose.model('User', userSchema);
const generateToken = () => crypto.randomBytes(16).toString('hex');

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
    // if (Date.now() - lastMessageTime < COOLDOWN) return;
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

const FIVEM_SERVER_IP = process.env.FIVEM_IP;
const FIVEM_SERVER_PORT = process.env.FIVEM_PORT;

const checkSpecificPlayers = async () => {
    try {
        const response = await axios.get(`http://${FIVEM_SERVER_IP}:${FIVEM_SERVER_PORT}/players.json`);
        const players = response.data;
        
        // Players to check
        const targetPlayers = ["Nancy Roy", "Harley Quinn"];
        let foundPlayers = [];

        players.forEach(player => {
            if (targetPlayers.includes(player.name)) {
                foundPlayers.push(player.name);
            }
        });

        if (foundPlayers.length > 0) {
            return `me hu ${foundPlayers.join(" & ")}.\nor me RP khel rahi hu\naye bade!!!`;
        } else {
            return `❌ Not found. Current players: \n${players.map(p => p.name).join("\n") || "No players online."}`;
        }
    } catch (error) {
        console.error('❌ Error fetching FiveM player list:', error);
        return '⚠️ Error fetching server data.';
    }
};

const monitorStatus = async () => {
    try {
        const fetchStatus = async () => {
            const response = await axios.get(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/`, {
                params: { key: process.env.STEAM_API_KEY, steamids: steamId }
            });
            return response.data?.response?.players?.[0]?.personastate === 1 ? 'online' : 'offline';
        };

        const firstCheck = await fetchStatus();
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
        const secondCheck = await fetchStatus();

        if (firstCheck === secondCheck && lastKnownStatus !== firstCheck) {
            lastKnownStatus = firstCheck;
            sendTelegramMessage(lastKnownStatus === 'offline' ? 
                "Jaa rahi hu me OFFLINE\naye bade😤" : 
                "Aa gyi ONLINE\nTumhare sath nhi khelungi\naye bade😤"
            );

            // ✅ Update the MongoDB database with the new status
            const { date, time } = getCurrentDateTime();
            await User.findOneAndUpdate(
                { steamId }, 
                { 
                    steamStatus: lastKnownStatus,
                    $push: { statusHistory: { status: lastKnownStatus, date, time } } 
                },
                { new: true, upsert: true } // Create user if not found
            );
            console.log(`📌 Status updated in DB: ${lastKnownStatus}`);
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

const checkSpecificPlayers = async () => {
    try {
        const response = await axios.get(`http://${FIVEM_SERVER_IP}:${FIVEM_SERVER_PORT}/players.json`);
        const players = response.data.map(p => p.name);

        // Fetch previous players from the database
        const previousPlayers = await Player.find().select('name -_id');
        const previousPlayerNames = previousPlayers.map(p => p.name);

        // Retain only players who were in the previous list
        const retainedPlayers = players.filter(player => previousPlayerNames.includes(player));

        // Update database with new player list (remove old ones)
        await Player.deleteMany({ name: { $nin: players } }); // Remove players no longer present
        await Player.updateMany({}, { $set: { lastSeen: new Date() } }); // Update timestamps
        const newPlayers = players.filter(p => !previousPlayerNames.includes(p));

        // Insert new players into the database
        if (newPlayers.length > 0) {
            await Player.insertMany(newPlayers.map(name => ({ name })));
        }

        return retainedPlayers.length > 0
            ? `Players retained: ${retainedPlayers.join(", ")}.`
            : `No retained players.`;

    } catch (error) {
        console.error('❌ Error fetching FiveM player list:', error);
        return '⚠️ Error fetching server data.';
    }
};

bot.command('check', async (ctx) => {
    const result = await checkSpecificPlayers();
    ctx.reply(result);
});



bot.command('hola', (ctx) => ctx.reply(lastKnownStatus === 'offline' ? "Kya h\ngame me nhi hu\nBusy hu me\naye bade😤" : "Tumhari thoo!!!\ngame me hu me\naye bade😤"));


let count = 0;
let batiTimer = null;

bot.command('bati', async (ctx) => {
    let message;

    if (lastKnownStatus === 'online') {
        message = "Bola to tha game me hu\nnhi kar sakti bati bati😤";
    } else {
        switch (count) {
            case 0:
                message = "Ale Ale\nBati Bati kalega mela bacha, huh!!\nnhi karugi";
                break;
            case 1:
                message = "Chuppp😤";
                break;
            case 2:
                message = "😤";
                break;
            case 3:
                message = "😤😤😤😤\nab agar bola na\nLiplock kardungi";
                break;
            default:
                message = "💋💋💋";
                break;
        }

        count++;

        // Clear previous timeout if the command is used again before 60 seconds
        if (batiTimer) clearTimeout(batiTimer);

        // Reset after 60 seconds of inactivity
        batiTimer = setTimeout(() => {
            count = 0;
            sendTelegramMessage("agar baat nhi krni hoti to bulaya mat karo\naye bade!!!");
        }, 60000);
    }

    ctx.reply(message);
});



bot.command('restart', (ctx) => {
    stopMonitoring();
    setTimeout(startMonitoring, 2000);
    ctx.reply('🔄 Monitoring restarted');
});

bot.command('game', async (ctx) => {
    const result = await checkSpecificPlayers();
    ctx.reply(result);
});


bot.launch();
console.log('🤖 Telegram Bot is running...');

app.get('/status', (req, res) => {
    // const token = req.headers.authorization;
    // if (!token) {
    //     return res.status(403).json({ error: 'Unauthorized' });
    // }
    sendTelegramMessage("Meri Location loge!!! aye bade");
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

setInterval(() => axios.get(`${process.env.SERVER_URL}`).catch(() => console.log(lastKnownStatus)), 60000);
