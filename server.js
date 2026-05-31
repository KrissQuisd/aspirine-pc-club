const express = require('express');
const axios = require('axios');
require('dotenv').config();
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Функция для отправки в Telegram
async function sendToTelegram(bookingData) {
  const message = `
📅 *Новое бронирование!*

🎮 Тип: ${bookingData.type}
📆 Дата: ${bookingData.date}
🕐 Время: ${bookingData.time}
💰 Цена: ${bookingData.price} грн
📱 Телефон: ${bookingData.phone}
${bookingData.pc ? `🖥️ ПК: ${bookingData.pc}` : ''}
${bookingData.ps5Option ? `📺 PS5: ${bookingData.ps5Option}` : ''}
  `.trim();

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
    return true;
  } catch (error) {
    console.error('Ошибка отправки в Telegram:', error);
    return false;
  }
}

// Эндпоинт для бронирования
app.post('/api/book', async (req, res) => {
  const { date, time, price, phone, type, pc, ps5Option } = req.body;

  if (!date || !time || !price || !phone || !type) {
    return res.status(400).json({ error: 'Недостаточно данных' });
  }

  const success = await sendToTelegram({ date, time, price, phone, type, pc, ps5Option });

  if (success) {
    res.json({ success: true, message: '✅ Бронирование отправлено в Telegram' });
  } else {
    res.status(500).json({ success: false, error: 'Ошибка отправки' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});