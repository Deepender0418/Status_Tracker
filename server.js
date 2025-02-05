const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');

dotenv.config();

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
        
        if (profileRegex.test(url)) {
            return url.match(profileRegex)[1];
        } else if (idRegex.test(url)) {
            const vanityName = url.match(idRegex)[1];
            const response = await axios.get(
                `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/`,
                {
                    params: {
                        key: process.env.STEAM_API_KEY,
                        vanityurl: vanityName
                    }
                }
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

const sendTelegramMessage = async (message) => {
    try {
        const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        });

        console.log('📩 Telegram message sent:', message);
    } catch (error) {
        console.error('❌ Error sending Telegram message:', error);
    }
};

let steamId, steamUsername, lastKnownStatus = null;

(async () => {
    const steamProfileUrl = process.env.STEAM_PROFILE_URL || '';
    steamId = await resolveSteamId(steamProfileUrl);
    if (!steamId) {
        console.error('❌ Failed to resolve Steam ID. Check your profile URL and API key.');
        process.exit(1);
    }
    
    steamUsername = await fetchUsername();
    console.log(`✅ Resolved Steam ID: ${steamId} (${steamUsername})`);
    
    await createUser();
    monitorStatus();
})();

const fetchUsername = async () => {
    try {
        const response = await axios.get(
            `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/`,
            {
                params: {
                    key: process.env.STEAM_API_KEY,
                    steamids: steamId
                }
            }
        );
        return response.data.response.players[0]?.personaname || 'Tracked User';
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
    const date = now.toISOString().split('T')[0];

    let hours = now.getHours();
    let minutes = now.getMinutes();
    let seconds = now.getSeconds();
    const ampm = hours >= 12 ? 'PM' : 'AM';

    hours = hours % 12 || 12;

    const time = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')} ${ampm}`;
    
    return { date, time };
};

const monitorStatus = async () => {
    try {
        while (true) {
            const response = await axios.get(
                `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/`,
                {
                    params: {
                        key: process.env.STEAM_API_KEY,
                        steamids: steamId
                    }
                }
            );
            
            const player = response.data.response.players[0];
            if (!player) {
                console.error('❌ No player data found');
                return;
            }

            const user = await User.findOne({ steamId });
            if (!user) {
                console.error('❌ User not found');
                return;
            }

            const steamStatus = player.personastate === 1 ? 'online' : 'offline';

            if (lastKnownStatus !== steamStatus) {
                lastKnownStatus = steamStatus;
                const { date, time } = getCurrentDateTime();

                user.statusHistory.push({ status: steamStatus, date, time });

                console.log(`🔵 User: ${steamUsername} is now ${steamStatus} at ${date} ${time}`);
                user.steamStatus = steamStatus;
                await user.save();

                // Send Telegram alert for both online and offline
                if (steamStatus === 'online') {
                    sendTelegramMessage(`🚀 ${steamUsername} is now ONLINE!!!`);
                } else {
                    sendTelegramMessage(`⚠️ ${steamUsername} went OFFLINE!`);
                }
            }

            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    } catch (error) {
        console.error('❌ Error monitoring status:', error);
    }
};

app.get('/api/user/status', async (req, res) => {
    try {
        const user = await User.findOne({ steamId });
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json({
            username: user.username,
            steamId: user.steamId,
            currentStatus: user.steamStatus,
            history: user.statusHistory
        });
    } catch (error) {
        res.status(500).json({ message: '❌ Server Error' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
