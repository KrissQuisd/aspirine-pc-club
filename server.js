const express = require('express');
const axios = require('axios');
require('dotenv').config();
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(cors());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ADMIN_IDS = process.env.ADMIN_IDS?.split(',').map(id => parseInt(id)) || [];
const TIMEZONE = 'Europe/Kyiv';

// Telegram Bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ===== DATABASE SETUP =====
const dbPath = path.join(__dirname, 'bookings.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('❌ DB Error:', err);
  else console.log('✅ SQLite Connected');
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      pc_number TEXT,
      ps5_option TEXT,
      phone TEXT NOT NULL,
      price INTEGER NOT NULL,
      type TEXT NOT NULL,
      ip TEXT,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT,
      phone TEXT,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS club_status (
      id INTEGER PRIMARY KEY,
      is_closed INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`INSERT OR IGNORE INTO club_status (id, is_closed) VALUES (1, 0)`);
});

// ===== UTILITIES =====
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || 
         req.connection.remoteAddress || 'N/A';
}

function getBookingHours(priceStr) {
  const priceMap = {
    '100': 1, '200': 2, '300': 3, '360': 4,
    '440': 5, '500': 6, '520': 6, '720': 4,
    '1040': 6, '250': 1, '600': 3, '750': 3
  };
  return priceMap[priceStr] || 1;
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

function getCurrentDate() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
  return now.toISOString().split('T')[0];
}

// ===== BOOKING FUNCTIONS =====
function checkBlacklist(ip, phone) {
  return new Promise((resolve) => {
    db.get(
      `SELECT * FROM blacklist WHERE ip = ? OR phone = ? LIMIT 1`,
      [ip, phone],
      (err, row) => resolve(row || null)
    );
  });
}

function checkPCAvailability(date, time, pcNumber, bookingHours) {
  return new Promise((resolve) => {
    const [year, month, day] = date.split('-');
    const [hours, minutes] = time.split(':');
    
    const bookingStart = new Date(year, month - 1, day, parseInt(hours), parseInt(minutes), 0);
    const bookingEnd = new Date(bookingStart.getTime() + bookingHours * 60 * 60 * 1000);

    db.all(
      `SELECT * FROM bookings WHERE pc_number = ? AND date = ? AND status = 'active'`,
      [pcNumber, date],
      (err, rows) => {
        if (err) return resolve(null);

        for (let booking of rows) {
          const [bHours, bMinutes] = booking.time.split(':');
          const existingStart = new Date(year, month - 1, day, parseInt(bHours), parseInt(bMinutes), 0);
          const existingHours = getBookingHours(booking.price.toString());
          const existingEnd = new Date(existingStart.getTime() + existingHours * 60 * 60 * 1000);

          if (!(bookingEnd <= existingStart || bookingStart >= existingEnd)) {
            resolve({ occupied: true, busyUntil: existingEnd.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) });
            return;
          }
        }
        resolve({ occupied: false });
      }
    );
  });
}

function getTodayBookings() {
  return new Promise((resolve) => {
    const today = getCurrentDate();
    db.all(
      `SELECT * FROM bookings WHERE date = ? AND status = 'active' ORDER BY time ASC`,
      [today],
      (err, rows) => resolve(rows || [])
    );
  });
}

// ===== TELEGRAM BOT HANDLERS =====
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  
  if (!isAdmin(chatId)) {
    bot.sendMessage(chatId, '❌ У вас немає доступу');
    return;
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: '📋 Бронювання сьогодні', callback_data: 'bookings_today' }],
      [{ text: '⛔ Чорний список', callback_data: 'blacklist_menu' }],
      [{ text: '🔒 Закрити клуб', callback_data: 'close_club' }, { text: '🔓 Відкрити клуб', callback_data: 'open_club' }]
    ]
  };

  bot.sendMessage(chatId, '🎮 *АДМІН ПАНЕЛЬ ASPIRINE PC CLUB*\n\nВиберіть дію:', {
    reply_markup: keyboard,
    parse_mode: 'Markdown'
  });
});

// Callback Query Handler
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (!isAdmin(chatId)) {
    bot.answerCallbackQuery(query.id, '❌ Немає доступу', true);
    return;
  }

  try {
    if (data === 'bookings_today') {
      const bookings = await getTodayBookings();
      
      if (bookings.length === 0) {
        bot.editMessageText('📋 *Бронювання на сьогодні:* Немає', {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown'
        });
        return;
      }

      let text = '📋 *Бронювання на сьогодні:*\n\n';
      const keyboard = { inline_keyboard: [] };

      bookings.forEach((booking, index) => {
        const hours = getBookingHours(booking.price.toString());
        text += `${index + 1}. *${booking.time}* - ${booking.type}${booking.pc_number ? ` (${booking.pc_number})` : ''}\n`;
        text += `   💰 ${booking.price} грн | 📱 ${booking.phone}\n\n`;

        keyboard.inline_keyboard.push([
          { text: `❌ Скасувати #${booking.id}`, callback_data: `cancel_${booking.id}` }
        ]);
        keyboard.inline_keyboard.push([
          { text: `🔄 Перенести #${booking.id}`, callback_data: `reschedule_${booking.id}` }
        ]);
      });

      keyboard.inline_keyboard.push([
        { text: '◀️ Назад', callback_data: 'start' }
      ]);

      bot.editMessageText(text, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    }
    else if (data === 'blacklist_menu') {
      const keyboard = {
        inline_keyboard: [
          [{ text: '➕ Додати в чорний список', callback_data: 'add_blacklist' }],
          [{ text: '📋 Переглянути список', callback_data: 'view_blacklist' }],
          [{ text: '◀️ Назад', callback_data: 'start' }]
        ]
      };

      bot.editMessageText('⛔ *Управління чорним списком*', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    }
    else if (data === 'add_blacklist') {
      bot.sendMessage(chatId, '📱 Надішліть номер телефону або IP адресу для додання в чорний список:');
      bot.once('message', (msg) => {
        const entry = msg.text.trim();
        const isIP = /^\d+\.\d+\.\d+\.\d+$/.test(entry);
        
        db.run(
          `INSERT INTO blacklist (${isIP ? 'ip' : 'phone'}, reason) VALUES (?, 'Додано адміном')`,
          [entry],
          () => {
            bot.sendMessage(chatId, `✅ ${isIP ? 'IP' : 'Телефон'} ${entry} додано в чорний список`);
          }
        );
      });
    }
    else if (data === 'view_blacklist') {
  db.all(`SELECT * FROM blacklist ORDER BY created_at DESC`, (err, rows) => {

    if (!rows || rows.length === 0) {
      bot.sendMessage(chatId, '📋 Чорний список порожній');
      return;
    }

    let text = '⛔ *Чорний список:*\n\n';

    const keyboard = {
      inline_keyboard: []
    };

    rows.forEach((entry, index) => {

      text += `${index + 1}. ${entry.phone || entry.ip}\n`;

      keyboard.inline_keyboard.push([
        {
          text: `🗑 Видалити #${entry.id}`,
          callback_data: `remove_blacklist_${entry.id}`
        }
      ]);

    });

    keyboard.inline_keyboard.push([
      {
        text: '◀️ Назад',
        callback_data: 'blacklist_menu'
      }
    ]);

    bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
      });

     });
   }
    else if (data === 'close_club') {
      db.run(`UPDATE club_status SET is_closed = 1 WHERE id = 1`, () => {
        bot.answerCallbackQuery(query.id, '🔒 Клуб закрито!', true);
        bot.sendMessage(chatId, '🔒 Клуб закрито для клієнтів');
      });
    }
    else if (data === 'open_club') {
      db.run(`UPDATE club_status SET is_closed = 0 WHERE id = 1`, () => {
        bot.answerCallbackQuery(query.id, '🔓 Клуб відкрито!', true);
        bot.sendMessage(chatId, '🔓 Клуб відкрито для клієнтів');
      });
    }
    else if (data.startsWith('cancel_')) {
      const bookingId = parseInt(data.split('_')[1]);
      db.run(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`, [bookingId], () => {
        bot.answerCallbackQuery(query.id, '✅ Бронювання скасовано', true);
        bot.sendMessage(chatId, `✅ Бронювання #${bookingId} скасовано`);
      });
    }
      else if (data.startsWith('reschedule_')) {

  const bookingId = parseInt(
    data.replace('reschedule_', '')
  );

  bot.sendMessage(
    chatId,
    `🔄 Введіть нові дані:

Формат:

дата час пк

Приклад:

2026-06-05 18:00 ПК №3`
  );

  bot.once('message', (msg) => {

    const parts = msg.text.split(' ');

    if (parts.length < 3) {

      bot.sendMessage(
        chatId,
        '❌ Невірний формат'
      );

      return;
    }

    const newDate = parts[0];
    const newTime = parts[1];
    const newPc = parts.slice(2).join(' ');

    db.run(
      `UPDATE bookings
       SET date = ?,
           time = ?,
           pc_number = ?
       WHERE id = ?`,
      [
        newDate,
        newTime,
        newPc,
        bookingId
      ],
      () => {

        bot.sendMessage(
          chatId,
          `✅ Бронювання #${bookingId} перенесено

📅 ${newDate}
🕐 ${newTime}
🖥 ${newPc}`
           );

          }
        );

       });

      }
      else if (data.startsWith('remove_blacklist_')) {

  const blacklistId = parseInt(
    data.replace('remove_blacklist_', '')
  );

  db.run(
    `DELETE FROM blacklist WHERE id = ?`,
    [blacklistId],
    () => {

      bot.answerCallbackQuery(
        query.id,
        '✅ Видалено'
      );

      bot.sendMessage(
        chatId,
        `✅ Запис #${blacklistId} видалено з чорного списку`
      );

       }
     );
   }
    else if (data === 'start') {
      bot.editMessageText('🎮 *АДМІН ПАНЕЛЬ ASPIRINE PC CLUB*\n\nВиберіть дію:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📋 Бронювання сьогодні', callback_data: 'bookings_today' }],
            [{ text: '⛔ Чорний список', callback_data: 'blacklist_menu' }],
            [{ text: '🔒 Закрити клуб', callback_data: 'close_club' }, { text: '🔓 Відкрити клуб', callback_data: 'open_club' }]
          ]
        }
      });
    }

    bot.answerCallbackQuery(query.id);
  } catch (error) {
    console.error('❌ Callback error:', error);
    bot.answerCallbackQuery(query.id, 'Помилка', true);
  }
});

// ===== REST API =====
app.get('/', (req, res) => {
  res.json({ status: '✅ Сервер працює' });
});

app.get('/api/club-status', (req, res) => {
  db.get(`SELECT is_closed FROM club_status WHERE id = 1`, (err, row) => {
    res.json({ isClosed: row?.is_closed === 1 });
  });
});

app.post('/api/book', async (req, res) => {
  const { date, time, price, phone, type, pc, ps5Option } = req.body;
  const clientIP = getClientIP(req);

  if (!date || !time || !price || !phone || !type) {
    return res.status(400).json({ success: false, error: 'Недостатньо даних' });
  }

  db.get(`SELECT is_closed FROM club_status WHERE id = 1`, async (err, row) => {
    if (row?.is_closed === 1) {
      return res.status(503).json({ 
        success: false, 
        error: 'Сьогодні клуб зачинений. Слідкуйте за новинами в Instagram!' 
      });
    }

    const blacklistEntry = await checkBlacklist(clientIP, phone);
    if (blacklistEntry) {
      console.warn(`⛔ Заблокована спроба: ${phone}`);
      return res.status(403).json({ success: false, error: '❌ Ви в чорному списку' });
    }

    if (type === 'ПК' && pc) {
      const hours = getBookingHours(price);
      const availability = await checkPCAvailability(date, time, pc, hours);
      
      if (availability?.occupied) {
        return res.status(409).json({ 
          success: false, 
          error: `❌ ${pc} зайнятий до ${availability.busyUntil}` 
        });
      }
    }

    db.run(
      `INSERT INTO bookings (date, time, pc_number, ps5_option, phone, price, type, ip) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [date, time, pc || null, ps5Option || null, phone, price, type, clientIP],
      async function(err) {
        if (err) {
          return res.status(500).json({ success: false, error: 'Помилка бази даних' });
        }

        const hours = getBookingHours(price);
        const message = `
🎮 *НОВЕ БРОНЮВАННЯ!*

📅 Дата: \`${date}\`
🕐 Час: \`${time}\`
⏱️ Тривалість: \`${hours} часа\`
💰 Ціна: \`${price} грн\`
📱 Телефон: \`${phone}\`
🎯 Тип: \`${type}\`
${pc ? `🖥️ ПК: ${pc}` : ps5Option ? `📺 PS5: ${ps5Option}` : ''}
🌐 IP: \`${clientIP}\`
        `.trim();

        try {
          await bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
        } catch (error) {
          console.error('❌ Telegram error:', error);
        }

        res.json({ 
          success: true, 
          message: '✅ Бронювання успішно! Чекайте на дзвінок для підтвердження',
          bookingId: this.lastID 
        });
      }
    );
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер на ${PORT}`);
  console.log(`🤖 Telegram Bot активний`);
  console.log(`👥 Адміни: ${ADMIN_IDS.join(', ')}`);
});
