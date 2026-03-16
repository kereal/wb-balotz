/**
 * WB Scraper - Система логирования
 * Красивый вывод в консоль и файл
 */

const fs = require('fs');
const path = require('path');

// Папка для логов
const LOGS_DIR = path.join(__dirname, 'logs');

// Создаём папку логов если нет
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Текущий файл лога
const LOG_FILE = path.join(LOGS_DIR, `scraper-${new Date().toISOString().split('T')[0]}.log`);

// Цвета для консоли
const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
};

// Эмодзи для типов сообщений
const ICONS = {
  info: 'ℹ️',
  success: '✅',
  error: '❌',
  warning: '⚠️',
  debug: '🔍',
  api: '📡',
  db: '💾',
  scrape: '🛒',
  timer: '⏱️',
  new: '🆕',
  stats: '📊',
};

// Форматирование даты
function formatDate(date = new Date()) {
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// Форматирование для файла (без цветов)
function formatFileMessage(level, message, data = null) {
  const timestamp = new Date().toISOString();
  let line = `[${timestamp}] [${level.toUpperCase().padEnd(7)}] ${message}`;
  if (data) {
    line += '\n' + JSON.stringify(data, null, 2);
  }
  return line;
}

// Форматирование для консоли (с цветами)
function formatConsoleMessage(level, message, data = null) {
  const timestamp = COLORS.dim + new Date().toLocaleTimeString('ru-RU') + COLORS.reset;
  const icon = ICONS[level] || '•';
  
  let color;
  switch (level) {
    case 'error': color = COLORS.red; break;
    case 'success': color = COLORS.green; break;
    case 'warning': color = COLORS.yellow; break;
    case 'api': color = COLORS.cyan; break;
    case 'db': color = COLORS.magenta; break;
    case 'new': color = COLORS.green + COLORS.bright; break;
    case 'stats': color = COLORS.blue; break;
    default: color = COLORS.white;
  }
  
  const levelStr = color + icon + ' ' + level.toUpperCase().padEnd(7) + COLORS.reset;
  let line = `${COLORS.dim}[${timestamp}]${COLORS.reset} ${levelStr} ${message}`;
  
  if (data) {
    line += '\n' + COLORS.dim + JSON.stringify(data, null, 2) + COLORS.reset;
  }
  
  return line;
}

// Запись в файл
function writeToFile(line) {
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) {
    // Игнорируем ошибки записи лога
  }
}

// Основная функция логирования
function log(level, message, data = null) {
  const fileMessage = formatFileMessage(level, message, data);
  const consoleMessage = formatConsoleMessage(level, message, data);
  
  // В консоль
  console.log(consoleMessage);
  
  // В файл
  writeToFile(fileMessage);
}

// Удобные методы
const logger = {
  info: (msg, data) => log('info', msg, data),
  success: (msg, data) => log('success', msg, data),
  error: (msg, data) => log('error', msg, data),
  warning: (msg, data) => log('warning', msg, data),
  debug: (msg, data) => log('debug', msg, data),
  api: (msg, data) => log('api', msg, data),
  db: (msg, data) => log('db', msg, data),
  scrape: (msg, data) => log('scrape', msg, data),
  timer: (msg, data) => log('timer', msg, data),
  new: (msg, data) => log('new', msg, data),
  stats: (msg, data) => log('stats', msg, data),
  
  // Заголовок (большой красивый блок)
  header: (title) => {
    const line = '═'.repeat(60);
    const lines = [
      '',
      COLORS.magenta + COLORS.bright + line + COLORS.reset,
      COLORS.magenta + COLORS.bright + '  ' + title + COLORS.reset,
      COLORS.magenta + COLORS.bright + line + COLORS.reset,
      ''
    ];
    console.log(lines.join('\n'));
    writeToFile('\n' + line + '\n  ' + title + '\n' + line + '\n');
  },
  
  // Разделитель
  separator: () => {
    const line = COLORS.dim + '─'.repeat(60) + COLORS.reset;
    console.log(line);
    writeToFile('─'.repeat(60));
  },
  
  // Прогресс
  progress: (current, total, message = '') => {
    const percent = Math.round((current / total) * 100);
    const bar = '█'.repeat(Math.floor(percent / 5)) + '░'.repeat(20 - Math.floor(percent / 5));
    const msg = COLORS.cyan + `[${bar}] ${percent}% (${current}/${total}) ${message}` + COLORS.reset;
    process.stdout.write('\r' + msg);
    writeToFile(`Progress: ${percent}% (${current}/${total}) ${message}`);
  },
  
  // Таблица
  table: (data, columns) => {
    console.log('');
    data.forEach((row, i) => {
      const values = columns.map(col => String(row[col] || '-').padEnd(col.length + 2));
      console.log('  ' + (i + 1) + '. ' + values.join(' '));
    });
    console.log('');
  },
  
  // Путь к файлу логов
  getLogFile: () => LOG_FILE,
  
  // Очистка старых логов (старше 30 дней)
  cleanOldLogs: () => {
    try {
      const files = fs.readdirSync(LOGS_DIR);
      const now = Date.now();
      const days30 = 30 * 24 * 60 * 60 * 1000;
      
      files.forEach(file => {
        const filePath = path.join(LOGS_DIR, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > days30) {
          fs.unlinkSync(filePath);
          logger.info(`Удалён старый лог: ${file}`);
        }
      });
    } catch (e) {
      // Игнорируем
    }
  }
};

module.exports = logger;
