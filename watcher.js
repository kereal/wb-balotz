/**
 * WB Watcher - Автоматический запуск скрапера по расписанию
 * 
 * Запускает scraper.js каждые N минут
 * Автоматически перезапускается при ошибках
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const logger = require('./logger');

// =====================================================
// КОНФИГУРАЦИЯ
// =====================================================

// Интервал запуска в минутах (можно изменить)
const INTERVAL_MINUTES = process.env.INTERVAL_MINUTES 
  ? parseInt(process.env.INTERVAL_MINUTES) 
  : 60; // По умолчанию каждый час

// Задержка при ошибке
const ERROR_DELAY_MINUTES = 5;

// =====================================================
// ЗАПУСК СКРАПЕРА
// =====================================================

let isRunning = false;
let lastRun = null;
let nextRun = null;

function runScraper() {
  return new Promise((resolve, reject) => {
    if (isRunning) {
      logger.warning('Скрапер уже запущен, пропускаем');
      resolve({ skipped: true });
      return;
    }
    
    isRunning = true;
    lastRun = new Date();
    
    logger.header('WB WATCHER - Запуск скрапера');
    logger.timer(`Интервал: ${INTERVAL_MINUTES} мин`);
    
    const child = spawn('node', ['scraper.js'], {
      cwd: __dirname,
      stdio: 'inherit'
    });
    
    child.on('close', (code) => {
      isRunning = false;
      
      if (code === 0) {
        logger.success('Скрапер завершён успешно');
        resolve({ success: true });
      } else {
        logger.error(`Скрапер завершился с кодом ${code}`);
        reject(new Error(`Exit code ${code}`));
      }
    });
    
    child.on('error', (err) => {
      isRunning = false;
      logger.error('Ошибка запуска: ' + err.message);
      reject(err);
    });
  });
}

// =====================================================
// ПЛАНИРОВЩИК
// =====================================================

let timeoutId = null;

function scheduleNextRun(delayMinutes) {
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
  
  const delayMs = delayMinutes * 60 * 1000;
  nextRun = new Date(Date.now() + delayMs);
  
  logger.timer(`Следующий запуск: ${nextRun.toLocaleString('ru-RU')}`);
  
  timeoutId = setTimeout(async () => {
    try {
      await runScraper();
      scheduleNextRun(INTERVAL_MINUTES);
    } catch (error) {
      logger.error('Ошибка: ' + error.message);
      logger.timer(`Повтор через ${ERROR_DELAY_MINUTES} мин`);
      scheduleNextRun(ERROR_DELAY_MINUTES);
    }
  }, delayMs);
}

// =====================================================
// СТАТУС
// =====================================================

function printStatus() {
  logger.header('WB WATCHER - Статус');
  console.log(`  📅 Запущен: ${startTime.toLocaleString('ru-RU')}`);
  console.log(`  ⏱️ Интервал: ${INTERVAL_MINUTES} мин`);
  console.log(`  🔄 Последний: ${lastRun ? lastRun.toLocaleString('ru-RU') : 'ещё не запускался'}`);
  console.log(`  ⏳ Следующий: ${nextRun ? nextRun.toLocaleString('ru-RU') : '-'}`);
  console.log(`  📄 Лог: ${logger.getLogFile()}`);
  logger.separator();
}

// =====================================================
// ЗАПУСК
// =====================================================

const startTime = new Date();

logger.header('WB WATCHER - Автоматический запуск');
logger.success('Сервис запущен');
logger.timer(`Интервал: ${INTERVAL_MINUTES} минут`);
logger.info('Нажмите Ctrl+C для остановки');
logger.separator();

// Первый запуск сразу
runScraper()
  .then(() => scheduleNextRun(INTERVAL_MINUTES))
  .catch((err) => {
    logger.error('Первый запуск не удался: ' + err.message);
    scheduleNextRun(ERROR_DELAY_MINUTES);
  });

// Graceful shutdown
process.on('SIGINT', () => {
  logger.warning('\nОстановка сервиса...');
  if (timeoutId) clearTimeout(timeoutId);
  logger.info('До свидания!');
  process.exit(0);
});

// Показать статус по сигналу
process.on('SIGUSR1', printStatus);
