/***********************************************************************
 * ALL-IN-ONE TELEGRAM BOT (Node.js + MySQL) EXAMPLE
 *
 * Features:
 *  - /start: Registers or updates the user in the "users" table
 *  - /admin: Basic admin panel (stats, broadcast, schedule)
 *  - Admin commands:
 *     /stats, /addadmin, /removeadmin, /broadcast, /schedule
 *  - Broadcast with rate-limit (300/min ~ 5/sec)
 *  - Daily scheduled messages (stored in "scheduled_messages" table)
 *
 * Dependencies: node-telegram-bot-api, mysql2, node-cron
 ***********************************************************************/

const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2/promise');
const cron = require('node-cron');

/***********************************************************************
 * CONFIGURATION
 ***********************************************************************/
const CONFIG = {
  BOT_TOKEN: '7895867616:AAFhf4T1XBRNfhj_w97Q8WNgetFxb6GcIh4', // from BotFather
  MAIN_ADMIN_ID: 123456789,                  // your Telegram user ID (main admin)
  DEFAULT_WELCOME: 'Welcome to our Telegram Bot!',
  // MySQL credentials
  DB: {
    host: 'localhost',
    user: 'Godbe',
    password: 'Hrahfhrahf',
    database: 'jojo',
    port: 3306,
  },
  // Rate limiting: 300 messages/min => 5 messages/sec
  BROADCAST_BATCH_SIZE: 5,
  BROADCAST_DELAY_MS: 1000, // 1 second between each batch
};

/***********************************************************************
 * GLOBALS
 ***********************************************************************/
let bot;              // Telegram bot instance
let dbPool;           // MySQL connection pool

/***********************************************************************
 * DATABASE FUNCTIONS
 ***********************************************************************/
async function initDB() {
  // Create a connection pool
  dbPool = await mysql.createPool({
    host: CONFIG.DB.host,
    user: CONFIG.DB.user,
    password: CONFIG.DB.password,
    database: CONFIG.DB.database,
    port: CONFIG.DB.port,
    waitForConnections: true,
    connectionLimit: 10, // adjust as needed
    queueLimit: 0,
  });

  // Initialize tables if they don't exist
  await initTables();
}

// Called once at startup
async function initTables() {
  // Create the "users", "admins", "scheduled_messages" tables if not already existing
  const createUsers = `
    CREATE TABLE IF NOT EXISTS users (
      user_id BIGINT PRIMARY KEY,
      join_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      start_count INT DEFAULT 1
    )
  `;
  const createAdmins = `
    CREATE TABLE IF NOT EXISTS admins (
      admin_id BIGINT PRIMARY KEY
    )
  `;
  const createScheduled = `
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      message TEXT,
      media_type VARCHAR(50),
      media_file_id VARCHAR(200),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  // Run queries
  const conn = await dbPool.getConnection();
  try {
    await conn.execute(createUsers);
    await conn.execute(createAdmins);
    await conn.execute(createScheduled);
  } finally {
    conn.release();
  }
}

async function addUser(userId) {
  const conn = await dbPool.getConnection();
  try {
    const [rows] = await conn.execute('SELECT user_id FROM users WHERE user_id=?', [userId]);
    if (rows.length === 0) {
      // Insert
      await conn.execute('INSERT INTO users (user_id) VALUES (?)', [userId]);
    } else {
      // Update start_count
      await conn.execute('UPDATE users SET start_count = start_count + 1 WHERE user_id=?', [userId]);
    }
  } finally {
    conn.release();
  }
}

async function removeUser(userId) {
  const conn = await dbPool.getConnection();
  try {
    await conn.execute('DELETE FROM users WHERE user_id=?', [userId]);
  } finally {
    conn.release();
  }
}

async function getUserCount() {
  const conn = await dbPool.getConnection();
  try {
    const [rows] = await conn.execute('SELECT COUNT(*) as cnt FROM users');
    return rows[0].cnt;
  } finally {
    conn.release();
  }
}

async function isAdmin(userId) {
  const conn = await dbPool.getConnection();
  try {
    const [rows] = await conn.execute('SELECT admin_id FROM admins WHERE admin_id=?', [userId]);
    return rows.length > 0;
  } finally {
    conn.release();
  }
}

async function addAdmin(userId) {
  const conn = await dbPool.getConnection();
  try {
    // If already exists, do nothing
    await conn.execute('INSERT IGNORE INTO admins (admin_id) VALUES (?)', [userId]);
  } finally {
    conn.release();
  }
}

async function removeAdmin(userId) {
  const conn = await dbPool.getConnection();
  try {
    await conn.execute('DELETE FROM admins WHERE admin_id=?', [userId]);
  } finally {
    conn.release();
  }
}

async function addScheduledMessage(message, mediaType = null, mediaFileId = null) {
  const conn = await dbPool.getConnection();
  try {
    // If there are >=10 scheduled messages, remove the oldest
    const [countRows] = await conn.execute('SELECT COUNT(*) as cnt FROM scheduled_messages');
    const count = countRows[0].cnt;
    if (count >= 10) {
      // remove oldest
      const [oldest] = await conn.execute('SELECT id FROM scheduled_messages ORDER BY id ASC LIMIT 1');
      const oldestId = oldest[0].id;
      await conn.execute('DELETE FROM scheduled_messages WHERE id=?', [oldestId]);
    }
    // Insert new
    await conn.execute(
      'INSERT INTO scheduled_messages (message, media_type, media_file_id) VALUES (?, ?, ?)',
      [message, mediaType, mediaFileId]
    );
  } finally {
    conn.release();
  }
}

async function getScheduledMessages() {
  const conn = await dbPool.getConnection();
  try {
    const [rows] = await conn.execute('SELECT * FROM scheduled_messages ORDER BY id ASC');
    return rows;
  } finally {
    conn.release();
  }
}

async function deleteScheduledMessage(id) {
  const conn = await dbPool.getConnection();
  try {
    await conn.execute('DELETE FROM scheduled_messages WHERE id=?', [id]);
  } finally {
    conn.release();
  }
}

async function getAllUsers() {
  const conn = await dbPool.getConnection();
  try {
    const [rows] = await conn.execute('SELECT user_id FROM users');
    return rows.map(r => r.user_id);
  } finally {
    conn.release();
  }
}

/***********************************************************************
 * HELPER / LOGGING / RATE-LIMIT
 ***********************************************************************/
function logInfo(msg) {
  console.log(`[INFO] ${new Date().toISOString()} - ${msg}`);
}
function logError(err) {
  console.error(`[ERROR] ${new Date().toISOString()} - ${err}`);
}

/**
 * Rate-limited broadcast
 * - users: array of chatIds
 * - sendFunc: async function(chatId) that sends the message
 */
async function rateLimitedBroadcast(users, sendFunc) {
  let successes = 0;
  let failures = 0;
  const total = users.length;
  let current = 0;

  for (let i = 0; i < total; i += CONFIG.BROADCAST_BATCH_SIZE) {
    const batch = users.slice(i, i + CONFIG.BROADCAST_BATCH_SIZE);
    const promises = batch.map(chatId => sendFunc(chatId).then(
      () => successes++,
      () => failures++
    ));
    await Promise.all(promises);
    current += batch.length;

    const progress = Math.floor((current / total) * 100);
    logInfo(`Broadcast progress: ${progress}% (${current}/${total})`);

    if (i + CONFIG.BROADCAST_BATCH_SIZE < total) {
      // wait a bit before next batch
      await new Promise(res => setTimeout(res, CONFIG.BROADCAST_DELAY_MS));
    }
  }
  return { successes, failures };
}

/***********************************************************************
 * BOT COMMANDS
 ***********************************************************************/

/** /start - register user and send welcome */
async function handleStart(msg) {
  const chatId = msg.chat.id;
  await addUser(chatId);
  await bot.sendMessage(chatId, CONFIG.DEFAULT_WELCOME);
  logInfo(`User ${chatId} started the bot`);
}

/** /admin - display admin menu */
async function handleAdmin(msg) {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) {
    return bot.sendMessage(chatId, 'Access denied. You are not an admin.');
  }

  const text = `Admin Panel:
/stats - View total user count
/addadmin <id> - Add admin (main admin only)
/removeadmin <id> - Remove admin (main admin only)
/broadcast - Start broadcast conversation
/schedule - Schedule a daily message`;
  await bot.sendMessage(chatId, text);
}

/** /stats - show total user count */
async function handleStats(msg) {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) return;

  const count = await getUserCount();
  await bot.sendMessage(chatId, `Total registered users: ${count}`);
}

/** /addadmin <id> - only MAIN_ADMIN_ID can add new admins */
async function handleAddAdmin(msg, match) {
  const chatId = msg.chat.id;
  if (chatId != CONFIG.MAIN_ADMIN_ID) {
    return bot.sendMessage(chatId, 'Only the main admin can add new admins.');
  }
  const newAdminId = match[1];
  await addAdmin(newAdminId);
  await bot.sendMessage(chatId, `User ${newAdminId} added as admin.`);
  try {
    // Notify the new admin
    await bot.sendMessage(newAdminId, 'You have been granted admin access.');
  } catch (e) {
    logError(`Could not notify new admin: ${e}`);
  }
}

/** /removeadmin <id> - only MAIN_ADMIN_ID can remove admins */
async function handleRemoveAdmin(msg, match) {
  const chatId = msg.chat.id;
  if (chatId != CONFIG.MAIN_ADMIN_ID) {
    return bot.sendMessage(chatId, 'Only the main admin can remove admins.');
  }
  const removeId = match[1];
  await removeAdmin(removeId);
  await bot.sendMessage(chatId, `Admin ${removeId} removed.`);
  try {
    await bot.sendMessage(removeId, 'Your admin privileges have been revoked.');
  } catch (e) {
    logError(`Could not notify removed admin: ${e}`);
  }
}

/***********************************************************************
 * BROADCAST LOGIC
 ***********************************************************************/
let broadcastStates = {}; // store state per admin (in-memory for example)

async function handleBroadcastStart(msg) {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) {
    return bot.sendMessage(chatId, 'Access denied. You are not an admin.');
  }
  // ask for the message
  broadcastStates[chatId] = { step: 'collecting' };
  await bot.sendMessage(chatId, 'Send the message (text or media) to broadcast, or /cancelbroadcast to cancel.');
}

async function handleBroadcastMessage(msg) {
  const chatId = msg.chat.id;
  const state = broadcastStates[chatId];
  if (!state || state.step !== 'collecting') return;
  // store the content
  broadcastStates[chatId] = {
    step: 'collected',
    content: msg,
  };
  await bot.sendMessage(chatId, 'Got it. Type /confirmbroadcast to send or /cancelbroadcast to cancel.');
}

async function handleBroadcastConfirm(msg) {
  const chatId = msg.chat.id;
  const state = broadcastStates[chatId];
  if (!state || state.step !== 'collected') return;

  await bot.sendMessage(chatId, 'Starting broadcast...');

  // fetch all users
  const users = await getAllUsers();
  const broadcastMsg = state.content;

  // define sendFunc
  const sendFunc = async (userId) => {
    try {
      // check if there's media or just text
      if (broadcastMsg.photo) {
        const fileId = broadcastMsg.photo[broadcastMsg.photo.length - 1].file_id;
        await bot.sendPhoto(userId, fileId, { caption: broadcastMsg.caption || '' });
      } else if (broadcastMsg.document) {
        await bot.sendDocument(userId, broadcastMsg.document.file_id, { caption: broadcastMsg.caption || '' });
      } else if (broadcastMsg.video) {
        await bot.sendVideo(userId, broadcastMsg.video.file_id, { caption: broadcastMsg.caption || '' });
      } else if (broadcastMsg.voice) {
        await bot.sendVoice(userId, broadcastMsg.voice.file_id, { caption: broadcastMsg.caption || '' });
      } else if (broadcastMsg.sticker) {
        await bot.sendSticker(userId, broadcastMsg.sticker.file_id);
      } else if (broadcastMsg.text) {
        await bot.sendMessage(userId, broadcastMsg.text);
      }
    } catch (err) {
      throw err;
    }
  };

  const { successes, failures } = await rateLimitedBroadcast(users, sendFunc);
  await bot.sendMessage(chatId, `Broadcast done! Successes: ${successes}, Failures: ${failures}`);

  // clean up
  delete broadcastStates[chatId];
}

async function handleBroadcastCancel(msg) {
  const chatId = msg.chat.id;
  if (broadcastStates[chatId]) {
    delete broadcastStates[chatId];
  }
  await bot.sendMessage(chatId, 'Broadcast canceled.');
}

/***********************************************************************
 * SCHEDULING LOGIC
 ***********************************************************************/
let scheduleStates = {};

async function handleScheduleStart(msg) {
  const chatId = msg.chat.id;
  if (!(await isAdmin(chatId))) {
    return bot.sendMessage(chatId, 'Access denied. You are not an admin.');
  }
  scheduleStates[chatId] = { step: 'collect' };
  await bot.sendMessage(chatId, 'Send the text or media you want to schedule daily, or /cancelschedule to cancel.');
}

async function handleScheduleMessage(msg) {
  const chatId = msg.chat.id;
  const state = scheduleStates[chatId];
  if (!state || state.step !== 'collect') return;

  let mediaType = null;
  let mediaFileId = null;
  let message = msg.caption || msg.text || '';

  if (msg.photo) {
    mediaType = 'photo';
    mediaFileId = msg.photo[msg.photo.length - 1].file_id;
  } else if (msg.document) {
    mediaType = 'document';
    mediaFileId = msg.document.file_id;
  } else if (msg.video) {
    mediaType = 'video';
    mediaFileId = msg.video.file_id;
  } else if (msg.voice) {
    mediaType = 'voice';
    mediaFileId = msg.voice.file_id;
  } else if (msg.sticker) {
    mediaType = 'sticker';
    mediaFileId = msg.sticker.file_id;
  }

  await addScheduledMessage(message, mediaType, mediaFileId);
  delete scheduleStates[chatId];
  await bot.sendMessage(chatId, 'Scheduled message added successfully!');
}

async function handleScheduleCancel(msg) {
  const chatId = msg.chat.id;
  if (scheduleStates[chatId]) delete scheduleStates[chatId];
  await bot.sendMessage(chatId, 'Scheduling canceled.');
}

/***********************************************************************
 * DAILY CRON JOB
 * Sends all scheduled messages to every user once a day
 ***********************************************************************/
function initDailyCron() {
  // This cron job runs every day at 00:00 (server time)
  // Adjust schedule string if needed (e.g., '0 0 * * *' is midnight).
  cron.schedule('0 0 * * *', async () => {
    logInfo('Running daily scheduled messages...');
    try {
      // get all scheduled messages
      const scheduled = await getScheduledMessages();
      if (!scheduled.length) return;

      const users = await getAllUsers();

      for (const row of scheduled) {
        const { id, message, media_type, media_file_id } = row;
        const sendFunc = async (userId) => {
          try {
            if (!media_type) {
              // text only
              await bot.sendMessage(userId, message);
            } else if (media_type === 'photo') {
              await bot.sendPhoto(userId, media_file_id, { caption: message });
            } else if (media_type === 'document') {
              await bot.sendDocument(userId, media_file_id, { caption: message });
            } else if (media_type === 'video') {
              await bot.sendVideo(userId, media_file_id, { caption: message });
            } else if (media_type === 'voice') {
              await bot.sendVoice(userId, media_file_id, { caption: message });
            } else if (media_type === 'sticker') {
              await bot.sendSticker(userId, media_file_id);
            }
          } catch (e) {
            // If user blocked, ignore error or remove user
          }
        };

        const { successes, failures } = await rateLimitedBroadcast(users, sendFunc);
        logInfo(`Scheduled [${id}] => Success: ${successes}, Fail: ${failures}`);

        // remove message from DB after sending
        await deleteScheduledMessage(id);
      }
    } catch (err) {
      logError(`Error in daily scheduled messages: ${err}`);
    }
  }, {
    timezone: 'UTC' // or your preferred timezone
  });
}

/***********************************************************************
 * MAIN STARTUP
 ***********************************************************************/
async function main() {
  try {
    // 1. Init DB
    await initDB();

    // 2. Ensure MAIN_ADMIN_ID is an admin
    await addAdmin(CONFIG.MAIN_ADMIN_ID);

    // 3. Create Telegram bot
    bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
    logInfo('Bot started...');

    // 4. Register commands
    bot.onText(/\/start/, handleStart);
    bot.onText(/\/admin/, handleAdmin);
    bot.onText(/\/stats/, handleStats);
    bot.onText(/\/addadmin (\\d+)/, handleAddAdmin);
    bot.onText(/\/removeadmin (\\d+)/, handleRemoveAdmin);

    // Broadcast
    bot.onText(/\/broadcast/, handleBroadcastStart);
    bot.onText(/\\\/confirmbroadcast/, handleBroadcastConfirm);
    bot.onText(/\\\/cancelbroadcast/, handleBroadcastCancel);

    // If admin is in the middle of broadcast collecting
    bot.on('message', async (msg) => {
      // if it's not a command, might be the broadcast content
      const chatId = msg.chat.id;
      if (broadcastStates[chatId]?.step === 'collecting') {
        await handleBroadcastMessage(msg);
      }
    });

    // Schedule
    bot.onText(/\/schedule/, handleScheduleStart);
    bot.onText(/\\\/cancelschedule/, handleScheduleCancel);

    // If admin is in the middle of schedule collecting
    bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      if (scheduleStates[chatId]?.step === 'collect') {
        // if it's not a recognized command, treat as scheduled content
        // be careful not to override the broadcast logic
        if (!msg.text?.startsWith('/')) {
          await handleScheduleMessage(msg);
        }
      }
    });

    // remove user if left or blocked
    bot.on('left_chat_member', async (msg) => {
      if (msg.left_chat_member) {
        const userId = msg.left_chat_member.id;
        await removeUser(userId);
        logInfo(`User ${userId} removed (left chat).`);
      }
    });

    bot.on('polling_error', (err) => {
      logError(`Polling error: ${err.message}`);
    });

    // 5. Init daily cron
    initDailyCron();

    logInfo('Setup complete. Bot is ready.');
  } catch (err) {
    logError(`Startup error: ${err}`);
    process.exit(1);
  }
}

// Start the bot
main().catch((err) => {
  logError(`Main error: ${err}`);
  process.exit(1);
});
