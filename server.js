const express = require('express');
const axios = require('axios');
require('dotenv').config();
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ Установи переменные окружения!');
  process.exit(1);
}

// 🛡️ ЗАЩИТА ОТ СПАМА
const ipLastBooking = new Map();
const SPAM_COOLDOWN = 10 * 60 * 1000; // 10 минут
const MIN_BOOKING_ADVANCE = 60 * 60 * 1000; // 1 час вперед

// Получение IP клиента
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress || 'N/A';
}

// ✅ Проверка спама по IP
function checkSpamLimit(ip) {
  const now = Date.now();
  const lastBookingTime = ipLastBooking.get(ip);
  
  if (!lastBookingTime) {
    return { allowed: true, message: null };
  }
  
  const timeSinceLastBooking = now - lastBookingTime;
  
  if (timeSinceLastBooking < SPAM_COOLDOWN) {
    const remainingSeconds = Math.ceil((SPAM_COOLDOWN - timeSinceLastBooking) / 1000);
    const minutes = Math.ceil(remainingSeconds / 60);
    return { 
      allowed: false, 
      message: `⏱️ Зачекай ${minutes} хвилин перед наступним бронюванням` 
    };
  }
  
  return { allowed: true, message: null };
}

// ✅ Проверка минимального времени бронирования (мин 1 час вперед)
function validateBookingTime(bookingDate, bookingTime) {
  const now = new Date();
  const [year, month, day] = bookingDate.split('-');
  const [hours, minutes] = bookingTime.split(':');
  
  const bookingDateTime = new Date(year, month - 1, day, hours, minutes, 0);
  const timeDiff = bookingDateTime - now;
  
  if (timeDiff < MIN_BOOKING_ADVANCE) {
    const hoursUntil = Math.floor(timeDiff / (1000 * 60 * 60));
    const minutesUntil = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
    
    return {
      valid: false,
      message: `⏳ Бронь можна робити щонайменше на 1 годину вперед. Нині залишилося: ${hoursUntil}ч ${minutesUntil}м`
    };
  }
  
  return { valid: true, message: null };
}

// Вычисление часов по цене
function getBookingHours(priceStr) {
  const priceMap = {
    '100': '1 час',
    '200': '2 часа',
    '300': '3 часа',
    '360': '4 часа',
    '440': '5 часов',
    '500': '6 часов',
    '520': '6 часов',
    '720': '4 часа',
    '1040': '6 часов',
    '250': '1 час',
    '600': '3 часа',
    '750': '3 часа'
  };
  return priceMap[priceStr] || priceStr;
}

// Расчет времени до бронирования
function getTimeUntilBooking(bookingDate, bookingTime) {
  const now = new Date();
  const [year, month, day] = bookingDate.split('-');
  const [hours, minutes] = bookingTime.split(':');
  
  const bookingDateTime = new Date(year, month - 1, day, hours, minutes, 0);
  const timeDiff = bookingDateTime - now;
  
  if (timeDiff < 0) return '❌ Дата вже минула!';
  
  const days = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
  const remainingHours = Math.floor((timeDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const remainingMinutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
  
  if (days > 0) {
    return `${days}д ${remainingHours}ч ${remainingMinutes}м`;
  } else if (remainingHours > 0) {
    return `${remainingHours}ч ${remainingMinutes}м`;
  } else {
    return `${remainingMinutes}м`;
  }
}

// Отправка в Telegram
async function sendToTelegram(bookingData, clientIP) {
  const { date, time, price, phone, type, pc, ps5Option } = bookingData;
  
  const hours = getBookingHours(price);
  const timeUntil = getTimeUntilBooking(date, time);
  
  const message = `
🎮 *НОВЕ ЗАБРОНЮВАННЯ!*

📅 Дата: \`${date}\`
🕐 Час: \`${time}\`
⏱️ Тривалість:: \`${hours}\`
💰 Ціна: \`${price} грн\`
📱 Телефон: \`${phone}\`
🎯 Тип: \`${type}\`
${pc ? `🖥️ ПК: ${pc}` : ps5Option ? `📺 PS5: ${ps5Option}` : ''}

⏳ До бронювання: \`${timeUntil}\`
🌐 IP адрес: \`${clientIP}\`
  `.trim();

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    }, { timeout: 5000 });
    return true;
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    return false;
  }
}

app.get('/', (req, res) => {
  res.json({ status: '✅ Сервер работает' });
});

app.post('/api/book', async (req, res) => {
  const { date, time, price, phone, type, pc, ps5Option } = req.body;
  const clientIP = getClientIP(req);

  if (!date || !time || !price || !phone || !type) {
    return res.status(400).json({ success: false, error: 'Недостатньо даних' });
  }

  // 🛡️ ПРОВЕРКА СПАМА
  const spamCheck = checkSpamLimit(clientIP);
  if (!spamCheck.allowed) {
    console.warn(`⚠️ Спам от ${clientIP}`);
    return res.status(429).json({ success: false, error: spamCheck.message });
  }

  // ⏳ ПРОВЕРКА МИНИМАЛЬНОГО ВРЕМЕНИ
  const timeCheck = validateBookingTime(date, time);
  if (!timeCheck.valid) {
    console.warn(`⚠️ Невірний час від ${clientIP}`);
    return res.status(400).json({ success: false, error: timeCheck.message });
  }

  console.log(`📥 Бронь от ${clientIP}: ${type} на ${date} в ${time}`);

  const success = await sendToTelegram({ date, time, price, phone, type, pc, ps5Option }, clientIP);

  if (success) {
    ipLastBooking.set(clientIP, Date.now()); // Обновляем время последней броне
    res.json({ success: true, message: '✅ Бронювання відправленно!' });
  } else {
    res.status(500).json({ success: false, error: 'Помилка відправки' });
  }
});

// Очистка старых записей каждый час
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamp] of ipLastBooking.entries()) {
    if (now - timestamp > 24 * 60 * 60 * 1000) {
      ipLastBooking.delete(ip);
    }
  }
  console.log(`🧹 Активных IP: ${ipLastBooking.size}`);
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на ${PORT}`);
  console.log(`🛡️ Спам-защита: 10 минут между бронями`);
  console.log(`⏳ Мин. время: 1 час вперед`);
});
