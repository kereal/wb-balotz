/**
 * WB Scraper - Playwright + WebKit
 * 
 * - Использует WebKit вместо Chromium (~100-200 MB вместо 600 MB)
 * - Красивое логирование в файл и консоль
 * - Retry с экспоненциальной задержкой
 * - Graceful shutdown
 */

const { webkit } = require('playwright');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const logger = require('./logger');

// =====================================================
// КОНФИГУРАЦИЯ
// =====================================================
const CONFIG = {
  // URL акции
  targetUrl: 'https://www.wildberries.ru/promotions/bally-za-otzyvy',
  warmupUrl: 'https://www.wildberries.ru',
  
  // Retry настройки
  maxRetries: 5,
  baseDelay: 5000,      // 5 сек базовая задержка
  maxDelay: 60000,      // 60 сек максимальная задержка
  
  // Browser настройки
  browserTimeout: 90000,
  pageLoadTimeout: 60000,
  waitAfterLoad: 25000,
  scrollCount: 10,
  scrollDelay: 2500,
  
  // Warmup настройки (прогрев сессии)
  warmupEnabled: true,
  warmupWait: 8000,
  
  // Пути
  dbPath: path.join(__dirname, 'products.db'),
  dataPath: path.join(__dirname, 'data'),
};

// Создаём папку данных
if (!fs.existsSync(CONFIG.dataPath)) {
  fs.mkdirSync(CONFIG.dataPath, { recursive: true });
}

// =====================================================
// БАЗА ДАННЫХ
// =====================================================
const db = new Database(CONFIG.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS all_products (
    wb_id INTEGER PRIMARY KEY,
    name TEXT,
    price INTEGER,
    sale_price INTEGER,
    feedback_points INTEGER,
    brand TEXT,
    seller TEXT,
    review_rating REAL,
    feedbacks INTEGER,
    url TEXT,
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    seen_count INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS new_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wb_id INTEGER UNIQUE,
    name TEXT,
    price INTEGER,
    sale_price INTEGER,
    feedback_points INTEGER,
    brand TEXT,
    seller TEXT,
    review_rating REAL,
    feedbacks INTEGER,
    url TEXT,
    found_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS scrape_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    status TEXT,
    products_found INTEGER DEFAULT 0,
    new_products INTEGER DEFAULT 0,
    error TEXT
  );
`);

logger.db('База данных инициализирована');

// =====================================================
// УТИЛИТЫ
// =====================================================

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryDelay(attempt) {
  const delayMs = Math.min(
    CONFIG.baseDelay * Math.pow(2, attempt),
    CONFIG.maxDelay
  );
  return delayMs + Math.random() * 1000;
}

function extractPrice(product) {
  try {
    if (product.sizes && product.sizes[0] && product.sizes[0].price) {
      return {
        price: Math.floor((product.sizes[0].price.basic || 0) / 100),
        salePrice: Math.floor((product.sizes[0].price.product || 0) / 100)
      };
    }
    if (product.priceU) {
      return {
        price: Math.floor(product.priceU / 100),
        salePrice: product.salePriceU ? Math.floor(product.salePriceU / 100) : 0
      };
    }
    return { price: product.price || 0, salePrice: product.salePrice || 0 };
  } catch (e) {
    return { price: 0, salePrice: 0 };
  }
}

// =====================================================
// СКРАПЕР
// =====================================================

let browser = null;
let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  logger.warning(`Получен сигнал ${signal}, завершаем работу...`);
  
  if (browser) {
    try {
      await browser.close();
      logger.info('Браузер закрыт');
    } catch (e) {}
  }
  
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.error('Необработанное исключение: ' + err.message, { stack: err.stack });
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error('Необработанный Promise rejection: ' + reason);
});

async function fetchProducts() {
  const allProducts = [];
  let attempt = 0;
  
  while (attempt < CONFIG.maxRetries && !isShuttingDown) {
    attempt++;
    
    logger.scrape(`Попытка ${attempt}/${CONFIG.maxRetries}`);
    logger.stats(`Память: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);
    
    try {
      // Запускаем WebKit браузер
      browser = await webkit.launch({
        headless: true,
        timeout: CONFIG.browserTimeout,
      });
      
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        locale: 'ru-RU',
        extraHTTPHeaders: {
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        }
      });
      
      const page = await context.newPage();
      
      // === БЛОКИРОВКА РЕСУРСОВ ===
      let blockedCount = 0;
      await page.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        if (['image', 'font'].includes(resourceType)) {
          blockedCount++;
          route.abort();
        } else {
          route.continue();
        }
      });
      
      // Устанавливаем таймауты
      page.setDefaultTimeout(CONFIG.pageLoadTimeout);
      
      // Перехват API ответов
      const apiData = [];
      let error498Count = 0;
      
      page.on('response', async (response) => {
        const url = response.url();
        const status = response.status();
        
        if (status === 200) {
          try {
            const contentType = response.headers()['content-type'] || '';
            if (contentType.includes('json')) {
              const data = await response.json();
              apiData.push({ url, data });
            }
          } catch (e) {}
        } else if (status === 498) {
          error498Count++;
          if (error498Count <= 2) {
            logger.timer(`Ожидание antibot... (${error498Count})`);
          }
        } else if (status >= 400) {
          logger.warning(`HTTP ${status}: ${url.substring(0, 60)}...`);
        }
      });
      
      // ПРОГРЕВ СЕССИИ
      if (CONFIG.warmupEnabled) {
        logger.timer('Прогрев сессии (главная страница)...');
        
        try {
          await page.goto(CONFIG.warmupUrl, {
            waitUntil: 'domcontentloaded',
            timeout: CONFIG.pageLoadTimeout
          });
          
          await delay(CONFIG.warmupWait);
          
          await page.evaluate(() => {
            window.scrollTo(0, 500);
          });
          await delay(2000);
          
          logger.success('Сессия прогрета');
        } catch (e) {
          logger.warning('Ошибка прогрева: ' + e.message);
        }
      }
      
      // Загружаем целевую страницу
      logger.api('Загрузка страницы: ' + CONFIG.targetUrl);
      
      await page.goto(CONFIG.targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: CONFIG.pageLoadTimeout
      });
      
      logger.timer('Ожидание загрузки данных...');
      await delay(CONFIG.waitAfterLoad);
      
      // Прокрутка для подгрузки товаров
      logger.scrape('Прокрутка страницы...');
      
      for (let i = 0; i < CONFIG.scrollCount; i++) {
        if (isShuttingDown) break;
        
        const scrollAmount = i % 3 === 0 ? -200 : 800 + Math.random() * 400;
        await page.evaluate((amount) => {
          window.scrollBy(0, amount);
        }, scrollAmount);
        
        logger.progress(i + 1, CONFIG.scrollCount);
        
        const randomDelay = CONFIG.scrollDelay + Math.random() * 2000;
        await delay(randomDelay);
      }
      
      console.log('');
      
      await delay(5000);
      
      logger.info(`Заблокировано ресурсов: ${blockedCount}`);
      
      // Закрываем
      await page.close();
      await context.close();
      await browser.close();
      browser = null;
      
      logger.stats(`Память после закрытия: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);
      
      // Обрабатываем собранные данные
      logger.api(`Обработка ${apiData.length} API ответов...`);
      
      apiData.forEach(({ data }) => {
        const productList = data.data?.products || data.products || [];
        
        productList.forEach(p => {
          if (!p.id && !p.nmId) return;
          
          const { price, salePrice } = extractPrice(p);
          
          allProducts.push({
            wb_id: p.id || p.nmId,
            name: p.name || '',
            price,
            sale_price: salePrice,
            feedback_points: p.feedbackPoints || 0,
            brand: p.brand || '',
            seller: p.supplier || '',
            review_rating: p.reviewRating || p.rating || 0,
            feedbacks: p.feedbacks || p.nmFeedbacks || 0,
            url: `https://www.wildberries.ru/catalog/${p.id || p.nmId}/detail.aspx`
          });
        });
      });
      
      // Уникализация
      const seen = new Set();
      const unique = allProducts.filter(p => {
        if (seen.has(p.wb_id)) return false;
        seen.add(p.wb_id);
        return true;
      });
      
      if (unique.length > 0) {
        logger.success(`Получено ${unique.length} товаров`);
        return unique;
      }
      
      logger.warning('Товары не получены');
      
    } catch (error) {
      logger.error('Ошибка: ' + error.message);
      
      if (browser) {
        try {
          await browser.close();
        } catch (e) {}
        browser = null;
      }
    }
    
    if (allProducts.length === 0 && attempt < CONFIG.maxRetries && !isShuttingDown) {
      const retryDelay = getRetryDelay(attempt);
      logger.timer(`Повтор через ${Math.round(retryDelay / 1000)} сек...`);
      await delay(retryDelay);
    }
  }
  
  return [];
}

// =====================================================
// ОСНОВНАЯ ЛОГИКА
// =====================================================

async function main() {
  const startTime = Date.now();
  
  logger.header('WB SCRAPER - Баллы за отзыв (WebKit)');
  
  logger.cleanOldLogs();
  
  const historyStmt = db.prepare(`
    INSERT INTO scrape_history (started_at, status) 
    VALUES (datetime('now'), 'running')
  `);
  const historyResult = historyStmt.run();
  const historyId = historyResult.lastInsertRowid;
  
  let newProductsCount = 0;
  let error = null;
  let currentProducts = [];
  
  try {
    const knownIds = new Set(
      db.prepare('SELECT wb_id FROM all_products').all().map(r => r.wb_id)
    );
    logger.stats(`Товаров в базе: ${knownIds.size}`);
    
    currentProducts = await fetchProducts();
    
    if (currentProducts.length === 0) {
      throw new Error('Не удалось получить товары с сайта');
    }
    
    const newProducts = currentProducts.filter(p => !knownIds.has(p.wb_id));
    newProductsCount = newProducts.length;
    
    logger.new(`Новых товаров: ${newProductsCount}`);
    
    const updateAll = db.prepare(`
      INSERT INTO all_products 
        (wb_id, name, price, sale_price, feedback_points, brand, seller, review_rating, feedbacks, url, first_seen, last_seen, seen_count)
      VALUES 
        (@wb_id, @name, @price, @sale_price, @feedback_points, @brand, @seller, @review_rating, @feedbacks, @url, datetime('now'), datetime('now'), 1)
      ON CONFLICT(wb_id) DO UPDATE SET 
        name = excluded.name,
        price = excluded.price,
        sale_price = excluded.sale_price,
        feedback_points = excluded.feedback_points,
        last_seen = datetime('now'),
        seen_count = seen_count + 1
    `);
    
    const updateAllTx = db.transaction((prods) => {
      prods.forEach(p => updateAll.run(p));
    });
    
    updateAllTx(currentProducts);
    logger.db('База всех товаров обновлена');
    
    if (newProducts.length > 0) {
      const insertNew = db.prepare(`
        INSERT OR IGNORE INTO new_products 
          (wb_id, name, price, sale_price, feedback_points, brand, seller, review_rating, feedbacks, url)
        VALUES 
          (@wb_id, @name, @price, @sale_price, @feedback_points, @brand, @seller, @review_rating, @feedbacks, @url)
      `);
      
      const insertNewTx = db.transaction((prods) => {
        prods.forEach(p => insertNew.run(p));
      });
      
      insertNewTx(newProducts);
      logger.db('Новые товары сохранены');
      
      logger.separator();
      logger.new('НОВЫЕ ТОВАРЫ:');
      
      newProducts.slice(0, 10).forEach((p, i) => {
        console.log(`  ${i + 1}. ${p.name?.substring(0, 45)}...`);
        console.log(`     💰 ${p.sale_price || p.price}₽ | 🎁 ${p.feedback_points || 0} баллов | ⭐ ${p.review_rating || '-'} | 💬 ${p.feedbacks || 0}`);
        console.log(`     🔗 ${p.url}`);
      });
      
      if (newProducts.length > 10) {
        console.log(`  ... и ещё ${newProducts.length - 10} товаров`);
      }
    }
    
    const exportData = {
      timestamp: new Date().toISOString(),
      total: currentProducts.length,
      new_count: newProducts.length,
      products: currentProducts
    };
    
    fs.writeFileSync(
      path.join(CONFIG.dataPath, 'products.json'),
      JSON.stringify(exportData, null, 2)
    );
    
    fs.writeFileSync(
      path.join(CONFIG.dataPath, 'new_products.json'),
      JSON.stringify(db.prepare('SELECT * FROM new_products ORDER BY found_at DESC').all(), null, 2)
    );
    
    logger.db('Данные экспортированы в JSON');
    
  } catch (e) {
    error = e.message;
    logger.error('Критическая ошибка: ' + e.message);
  }
  
  db.prepare(`
    UPDATE scrape_history 
    SET finished_at = datetime('now'),
        status = ?,
        products_found = ?,
        new_products = ?,
        error = ?
    WHERE id = ?
  `).run(
    error ? 'error' : 'success',
    currentProducts?.length || 0,
    newProductsCount,
    error || null,
    historyId
  );
  
  const duration = Math.round((Date.now() - startTime) / 1000);
  const stats = db.prepare(`
    SELECT 
      (SELECT COUNT(*) FROM all_products) as total,
      (SELECT COUNT(*) FROM new_products) as new_count
  `).get();
  
  logger.separator();
  logger.stats('ИТОГИ:');
  console.log(`  Время работы: ${Math.floor(duration / 60)}м ${duration % 60}с`);
  console.log(`  Всего товаров: ${stats.total}`);
  console.log(`  Новых товаров: ${stats.new_count}`);
  console.log(`  Пиковая память: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);
  console.log(`  Лог файл: ${logger.getLogFile()}`);
  logger.separator();
  
  logger.success('Готово!');
  
  return {
    success: !error,
    total: stats.total,
    newCount: newProductsCount,
    duration
  };
}

// =====================================================
// КОМАНДЫ
// =====================================================

function showNewProducts(limit = 20) {
  logger.header('НОВЫЕ ТОВАРЫ');
  
  const products = db.prepare(`
    SELECT * FROM new_products 
    ORDER BY found_at DESC 
    LIMIT ?
  `).all(limit);
  
  if (products.length === 0) {
    console.log('  Нет новых товаров');
    console.log('  Запустите scraper.js для поиска\n');
    return;
  }
  
  products.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.name?.substring(0, 45)}...`);
    console.log(`     💰 ${p.sale_price || p.price}₽ | 🎁 ${p.feedback_points || 0} баллов | ⭐ ${p.review_rating || '-'} | 💬 ${p.feedbacks || 0}`);
    console.log(`     🏷️ ${p.brand || '-'} | 📅 ${p.found_at}`);
    console.log(`     🔗 ${p.url}`);
  });
  
  const total = db.prepare('SELECT COUNT(*) as count FROM new_products').get();
  logger.separator();
  console.log(`  Всего новых: ${total.count}`);
}

function showStats() {
  logger.header('СТАТИСТИКА');
  
  const stats = db.prepare(`
    SELECT 
      (SELECT COUNT(*) FROM all_products) as total,
      (SELECT COUNT(*) FROM new_products) as new_count,
      (SELECT MIN(first_seen) FROM all_products) as first_scan,
      (SELECT MAX(last_seen) FROM all_products) as last_scan,
      (SELECT COUNT(*) FROM scrape_history WHERE status = 'success') as success_scans,
      (SELECT COUNT(*) FROM scrape_history WHERE status = 'error') as error_scans
  `).get();
  
  console.log(`  📦 Всего товаров: ${stats.total}`);
  console.log(`  🆕 Новых товаров: ${stats.new_count}`);
  console.log(`  ✅ Успешных сканов: ${stats.success_scans}`);
  console.log(`  ❌ Ошибок: ${stats.error_scans}`);
  console.log(`  📅 Первый скан: ${stats.first_scan || '-'}`);
  console.log(`  📅 Последний скан: ${stats.last_scan || '-'}`);
  console.log(`  📄 Лог файл: ${logger.getLogFile()}`);
  logger.separator();
}

function showHistory(limit = 10) {
  logger.header('ИСТОРИЯ СКАНОВ');
  
  const history = db.prepare(`
    SELECT * FROM scrape_history 
    ORDER BY started_at DESC 
    LIMIT ?
  `).all(limit);
  
  history.forEach((h, i) => {
    const status = h.status === 'success' ? '✅' : '❌';
    console.log(`  ${status} ${h.started_at} | Товаров: ${h.products_found} | Новых: ${h.new_products}`);
    if (h.error) {
      console.log(`     Ошибка: ${h.error}`);
    }
  });
  logger.separator();
}

// =====================================================
// ЗАПУСК
// =====================================================

const args = process.argv.slice(2);

if (args.includes('--new') || args.includes('-n')) {
  showNewProducts(parseInt(args[args.indexOf('--new') + 1] || args[args.indexOf('-n') + 1]) || 20);
} else if (args.includes('--stats') || args.includes('-s')) {
  showStats();
} else if (args.includes('--history') || args.includes('-h')) {
  showHistory();
} else if (args.includes('--help')) {
  console.log(`
📖 Использование:

  node scraper.js          - Запустить скрапер
  node scraper.js --new    - Показать новые товары (20)
  node scraper.js --new 50 - Показать новые товары (50)
  node scraper.js --stats  - Показать статистику
  node scraper.js --history- Показать историю сканов
  node scraper.js --help   - Эта справка

📁 Файлы:
  logs/scraper-YYYY-MM-DD.log  - Логи
  data/products.json           - Все товары
  data/new_products.json       - Новые товары

🧠 Использует WebKit браузер (меньше памяти чем Chromium)
`);
} else {
  main().catch(err => {
    logger.error('Фатальная ошибка: ' + err.message);
    process.exit(1);
  });
}

module.exports = { main, showNewProducts, showStats, showHistory };
