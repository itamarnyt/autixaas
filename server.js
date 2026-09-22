const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const sessions = new Map();
let db;

const ADMIN_OVERRIDE_PHONE = '972559707899@c.us';
const STOCK_KEYWORDS = [
    'מניות', 'מניה', 'השקעות', 'השקעה', 'שוק ההון', 'מסחר', 
    'קריפטו', 'ביטקוין', 'רווחים', 'אותות מסחר', 'אופציות', 
    'תשואה', 'בורסה', 'תיק השקעות'
];

async function initDatabase() {
    db = await open({ filename: './autix_admin.sqlite', driver: sqlite3.Database });
    await db.exec(`CREATE TABLE IF NOT EXISTS active_chats (chat_id TEXT PRIMARY KEY);`);
    await db.exec(`CREATE TABLE IF NOT EXISTS scam_list (phone_id TEXT PRIMARY KEY, reason TEXT, added_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
    console.log('✅ מסד הנתונים של א!טיקס מוכן!');
}

async function isChatActive(chatId) {
    const row = await db.get(`SELECT chat_id FROM active_chats WHERE chat_id = ?`, [chatId]);
    return !!row;
}

async function activateChat(chatId) {
    await db.run(`INSERT OR IGNORE INTO active_chats (chat_id) VALUES (?)`, [chatId]);
}

async function markAsScam(phoneId, reason = 'עוקץ') {
    await db.run(`INSERT OR REPLACE INTO scam_list (phone_id, reason) VALUES (?, ?)`, [phoneId, reason]);
    console.log(`🚨 המספר ${phoneId} סומן כ-${reason}`);
}

async function isScam(phoneId) {
    const row = await db.get(`SELECT phone_id, reason FROM scam_list WHERE phone_id = ?`, [phoneId]);
    return row ? row.reason : false;
}

async function isSenderAdmin(chat, senderId) {
    if (senderId === ADMIN_OVERRIDE_PHONE) return true;
    if (!chat.isGroup) return false;
    const participant = chat.participants.find(p => p.id._serialized === senderId);
    return participant && (participant.isAdmin || participant.isSuperAdmin);
}

app.post('/api/request-code', async (req, res) => {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
        return res.status(400).json({ error: 'יש לספק מספר טלפון בינלאומי (למשל 972501234567)' });
    }

    try {
        console.log(`📱 מכין בקשת חיבור עבור: ${phoneNumber}`);

        const client = new Client({
            authStrategy: new LocalAuth({ clientId: `session_${phoneNumber}` }),
            puppeteer: {
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-gpu'
                ]
            }
        });

        client.on('qr', async () => {
            try {
                const code = await client.requestPairingCode(phoneNumber);
                console.log(`🔑 קוד חיבור שנוצר עבור ${phoneNumber}: ${code}`);
                sessions.set(phoneNumber, { client, status: 'pairing' });
                return res.json({ success: true, pairingCode: code });
            } catch (err) {
                console.error('שגיאה ביצירת קוד:', err);
                if (!res.headersSent) res.status(500).json({ error: 'נכשל ביצירת קוד חיבור' });
            }
        });

        setupBotEvents(client, phoneNumber);
        await client.initialize();

    } catch (error) {
        console.error(error);
        if (!res.headersSent) res.status(500).json({ error: 'שגיאת שרת' });
    }
});

function setupBotEvents(client, ownerPhone) {
    client.on('ready', () => {
        console.log(`🤖 בוט הניהול של ${ownerPhone} מחובר ופעיל!`);
        sessions.set(ownerPhone, { client, status: 'ready' });
    });

    client.on('message_create', async (msg) => {
        try {
            const text = msg.body ? msg.body.trim() : '';
            if (!text) return;

            const chat = await msg.getChat();
            if (!chat.isGroup) return;

            const chatId = chat.id._serialized;
            const senderId = msg.author || msg.from;

            if (text === 'אוטיקס') {
                const isAdmin = await isSenderAdmin(chat, senderId);
                if (!isAdmin) {
                    await msg.reply('❌ רק מנהלי הקבוצה יכולים להפעיל אותי.');
                    return;
                }

                const active = await isChatActive(chatId);
                if (!active) {
                    await activateChat(chatId);
                    await msg.reply(`🤖 *א!טיקס* הופעל בהצלחה בקבוצה זו!`);
                } else {
                    await msg.reply(`🤖 *א!טיקס* כבר פעיל בקבוצה זו.`);
                }
                return;
            }

            if (!(await isChatActive(chatId))) return;

            const isGroupInvite = text.includes('chat.whatsapp.com');
            const containsStockKeyword = STOCK_KEYWORDS.some(kw => text.includes(kw));

            if (isGroupInvite && containsStockKeyword) {
                const senderAdmin = await isSenderAdmin(chat, senderId);
                if (!senderAdmin) {
                    await markAsScam(senderId, 'עוקץ להסיר דחוף');
                    try { await msg.delete(true); } catch (e) {}
                    try {
                        await chat.removeParticipants([senderId]);
                        await chat.sendMessage(`🚨 חבר קבוצה הוסר וסומן כ-*עוקץ* עקב שליחת קישור מניות.`);
                    } catch (e) {
                        await chat.sendMessage(`⚠️ התגלה קישור עוקץ! ודא שהבוט מוגדר כמנהל.`);
                    }
                    return;
                }
            }

            if (!text.startsWith('א!טיקס')) return;

            const isAdmin = await isSenderAdmin(chat, senderId);
            if (!isAdmin) {
                await msg.reply('❌ פקודה זו שמורה למנהלי הקבוצה בלבד.');
                return;
            }

            const command = text.replace('א!טיקס', '').trim();

            if (command === 'פתח קבוצה') {
                await chat.setMessagesAdminsOnly(false);
                await msg.reply('🔓 הקבוצה נפתחה לכולם.');
                return;
            }

            if (command === 'סגור קבוצה') {
                await chat.setMessagesAdminsOnly(true);
                await msg.reply('🔒 הקבוצה נסגרה (מנהלים בלבד).');
                return;
            }

            if (command === 'אישור בקשות') {
                await msg.reply('🔄 בודק בקשות ממתינות...');
                try {
                    const requests = await chat.getGroupMembershipRequests();
                    if (!requests || requests.length === 0) {
                        await msg.reply('ℹ️ אין בקשות ממתינות.');
                        return;
                    }

                    let approved = 0, rejected = 0;
                    for (const req of requests) {
                        const phone = req.address.split('@')[0];
                        const isIsraeli = phone.startsWith('972');
                        const scamStatus = await isScam(req.address);

                        if (isIsraeli && !scamStatus) {
                            await chat.approveGroupMembershipRequest(req.address);
                            approved++;
                        } else {
                            await chat.rejectGroupMembershipRequest(req.address);
                            rejected++;
                        }
                    }
                    await msg.reply(`✅ *סיכום:*\n• אושרו: ${approved}\n• נדחו/עוקץ: ${rejected}`);
                } catch (err) {
                    await msg.reply('⚠️ שגיאה בטיפול בבקשות.');
                }
                return;
            }

        } catch (err) {
            console.error('שגיאה:', err.message);
        }
    });
}

initDatabase().then(() => {
    app.listen(PORT, () => console.log(`🚀 שרת א!טיקס רץ על פורט ${PORT}`));
});
