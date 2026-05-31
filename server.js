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

// Функция для получения IP адреса
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress ||
         'N/A';
}

// Функция для вычисления часов бронирования
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

// Функция для расчета времени до бронирования
function getTimeUntilBooking(bookingDate, bookingTime) {
  const now = new Date();
  const [year, month, day] = bookingDate.split('-');
  const [hours, minutes] = bookingTime.split(':');
  
  const bookingDateTime = new Date(year, month - 1, day, hours, minutes, 0);
  const timeDiff = bookingDateTime - now;
  
  if (timeDiff < 0) {
    return '❌ Дата уже прошла!';
  }
  
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

// Функция для отправки в Telegram
async function sendToTelegram(bookingData, clientIP) {
  const { date, time, price, phone, type, pc, ps5Option } = bookingData;
  
  const hours = getBookingHours(price);
  const timeUntil = getTimeUntilBooking(date, time);
  
  const message = `
🎮 *НОВОЕ БРОНИРОВАНИЕ!*

📅 Дата: \`${date}\`
🕐 Время: \`${time}\`
⏱️ Длительность: \`${hours}\`
💰 Цена: \`${price} грн\`
📱 Телефон: \`${phone}\`
🎯 Тип: \`${type}\`
${pc ? `🖥️ ПК: ${pc}` : ps5Option ? `📺 PS5: ${ps5Option}` : ''}

⏳ До бронирования: \`${timeUntil}\`
🌐 IP адрес: \`${clientIP}\`
  `.trim();

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
    console.log('✅ Сообщение отправлено в Telegram');
    return true;
  } catch (error) {
    console.error('❌ Ошибка отправки в Telegram:', error.message);
    return false;
  }
}

app.get('/', (req, res) => {
  res.json({ status: '✅ Сервер работает' });
});

app.post('/api/book', async (req, res) => {
  const { date, time, price, phone, type, pc, ps5Option } = req.body;
  const clientIP = getClientIP(req);

  // Валидация данных
  if (!date || !time || !price || !phone || !type) {
    return res.status(400).json({ 
      success: false, 
      error: 'Недостаточно данных для бронирования' 
    });
  }

  console.log(`📥 Новое бронирование от ${clientIP}: ${type} на ${date} в ${time}`);

  const success = await sendToTelegram({ date, time, price, phone, type, pc, ps5Option }, clientIP);

  if (success) {
    res.json({ 
      success: true, 
      message: '✅ Бронирование успешно отправлено!' 
    });
  } else {
    res.status(500).json({ 
      success: false, 
      error: 'Ошибка отправки в Telegram' 
    });
  }
});

app.use((err, req, res, next) => {
  console.error('Ошибка:', err);
  res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
