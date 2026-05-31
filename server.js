const express = require('express');
const axios = require('axios');
require('dotenv').config();
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const TIMEZONE = 'Europe/Kyiv';

// ===== DATABASE SETUP =====
const dbPath = path.join(__dirname, 'bookings.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('❌ DB Error:', err);
  else console.log('✅ SQLite連接成功');
});

// Создаём таблицы
db.serialize(() => {
  // Таблица бронирований
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

  // Таблица чорного списку
  db.run(`
    CREATE TABLE IF NOT EXISTS blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT,
      phone TEXT,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Таблица статусу клубу
  db.run(`
    CREATE TABLE IF NOT EXISTS club_status (
      id INTEGER PRIMARY KEY,
      is_closed INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Вставляем начальный статус если таблица пуста
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

// ===== BOOKING VALIDATION =====
function checkBlacklist(ip, phone) {
  return new Promise((resolve) => {
    db.get(
      `SELECT * FROM blacklist WHERE ip = ? OR phone = ? LIMIT 1`,
      [ip, phone],
      (err, row) => {
        if (err) {
          console.error('❌ Blacklist error:', err);
          resolve(null);
        } else {
          resolve(row);
        }
      }
    );
  });
}

function checkPCAvailability(date, time, pcNumber, bookingHours) {
  return new Promise((resolve) => {
    const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
    const [year, month, day] = date.split('-');
    const [hours, minutes] = time.split(':');
    
    const bookingStart = new Date(year, month - 1, day, parseInt(hours), parseInt(minutes), 0);
    const bookingEnd = new Date(bookingStart.getTime() + bookingHours * 60 * 60 * 1000);

    db.all(
      `SELECT * FROM bookings 
       WHERE pc_number = ? AND date = ? AND status = 'active'`,
      [pcNumber, date],
      (err, rows) => {
        if (err) {
          console.error('❌ DB error:', err);
          resolve(null);
          return;
        }

        // Проверяем пересечение времени
        for (let booking of rows) {
          const [bHours, bMinutes] = booking.time.split(':');
          const existingStart = new Date(year, month - 1, day, parseInt(bHours), parseInt(bMinutes), 0);
          const existingHours = getBookingHours(booking.price.toString());
          const existingEnd = new Date(existingStart.getTime() + existingHours * 60 * 60 * 1000);

          // Проверяем пересечение временных интервалов
          if (!(bookingEnd <= existingStart || bookingStart >= existingEnd)) {
            resolve({
              occupied: true,
              busyUntil: existingEnd.toLocaleTimeString('uk-UA', { 
                hour: '2-digit', 
                minute: '2-digit',
                timeZone: TIMEZONE 
              })
            });
            return;
          }
        }

        resolve({ occupied: false });
      }
    );
  });
}

// ===== TELEGRAM FUNCTIONS =====
async function sendToTelegram(bookingData, clientIP, isAdmin = false) {
  const { date, time, price, phone, type, pc, ps5Option } = bookingData;
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
    const chatId = isAdmin ? ADMIN_CHAT_ID : TELEGRAM_CHAT_ID;
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown'
    }, { timeout: 5000 });
    return true;
  } catch (error) {
    console.error('❌ Telegram error:', error.message);
    return false;
  }
}

// ===== ROUTES =====
app.get('/', (req, res) => {
  res.json({ status: '✅ Сервер працює' });
});

app.get('/api/club-status', (req, res) => {
  db.get(`SELECT is_closed FROM club_status WHERE id = 1`, (err, row) => {
    if (err) {
      res.status(500).json({ error: 'DB error' });
    } else {
      res.json({ isClosed: row.is_closed === 1 });
    }
  });
});

app.post('/api/book', async (req, res) => {
  const { date, time, price, phone, type, pc, ps5Option } = req.body;
  const clientIP = getClientIP(req);

  // Базова валідація
  if (!date || !time || !price || !phone || !type) {
    return res.status(400).json({ success: false, error: 'Недостатньо даних' });
  }

  // Перевірка статусу клубу
  db.get(`SELECT is_closed FROM club_status WHERE id = 1`, async (err, row) => {
    if (row?.is_closed === 1) {
      return res.status(503).json({ 
        success: false, 
        error: 'Сьогодні клуб зачинений. Слідкуйте за новинами в Instagram!' 
      });
    }

    // Перевірка чорного списку
    const blacklistEntry = await checkBlacklist(clientIP, phone);
    if (blacklistEntry) {
      console.warn(`⛔ Заблокована спроба бронювання: ${phone}`);
      return res.status(403).json({ 
        success: false, 
        error: '❌ Ви в чорному списку' 
      });
    }

    // Перевірка доступності ПК
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

    // Зберігаємо бронювання в базу
    db.run(
      `INSERT INTO bookings (date, time, pc_number, ps5_option, phone, price, type, ip) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [date, time, pc || null, ps5Option || null, phone, price, type, clientIP],
      async function(err) {
        if (err) {
          console.error('❌ DB insert error:', err);
          return res.status(500).json({ success: false, error: 'Помилка бази даних' });
        }

        console.log(`📥 Нове бронювання: ID ${this.lastID}`);

        const success = await sendToTelegram({ date, time, price, phone, type, pc, ps5Option }, clientIP);

        if (success) {
          res.json({ 
            success: true, 
            message: '✅ Бронювання успішно! Чекайте на дзвінок для підтвердження',
            bookingId: this.lastID 
          });
        } else {
          res.status(500).json({ success: false, error: 'Помилка відправки' });
        }
      }
    );
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер на ${PORT}`);
  console.log(`📊 SQLite: ${dbPath}`);
  console.log(`🕐 Часовий пояс: ${TIMEZONE}`);
});
