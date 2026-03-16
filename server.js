/**
 * WB Scraper - Веб-сервер
 * С логированием и обработкой ошибок
 */

const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const logger = require('./logger');

const app = express();
const db = new Database(path.join(__dirname, 'products.db'));

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Логирование запросов
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.api(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// =====================================================
// API
// =====================================================

// Новые товары
app.get('/api/new', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    const products = db.prepare(`
      SELECT * FROM new_products 
      ORDER BY found_at DESC 
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    
    const total = db.prepare('SELECT COUNT(*) as count FROM new_products').get();
    
    res.json({
      success: true,
      data: products,
      total: total.count,
      limit,
      offset
    });
  } catch (error) {
    logger.error('API /api/new: ' + error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Все товары
app.get('/api/all', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    
    const products = db.prepare(`
      SELECT * FROM all_products 
      ORDER BY last_seen DESC 
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    
    const total = db.prepare('SELECT COUNT(*) as count FROM all_products').get();
    
    res.json({
      success: true,
      data: products,
      total: total.count,
      limit,
      offset
    });
  } catch (error) {
    logger.error('API /api/all: ' + error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Статистика
app.get('/api/stats', (req, res) => {
  try {
    const stats = db.prepare(`
      SELECT 
        (SELECT COUNT(*) FROM all_products) as total,
        (SELECT COUNT(*) FROM new_products) as new_count,
        (SELECT MIN(first_seen) FROM all_products) as first_scan,
        (SELECT MAX(last_seen) FROM all_products) as last_scan,
        (SELECT COUNT(*) FROM scrape_history WHERE status = 'success') as success_scans,
        (SELECT COUNT(*) FROM scrape_history WHERE status = 'error') as error_scans
    `).get();
    
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('API /api/stats: ' + error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// История сканов
app.get('/api/history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    
    const history = db.prepare(`
      SELECT * FROM scrape_history 
      ORDER BY started_at DESC 
      LIMIT ?
    `).all(limit);
    
    res.json({ success: true, data: history });
  } catch (error) {
    logger.error('API /api/history: ' + error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Поиск
app.get('/api/search', (req, res) => {
  try {
    const q = req.query.q || '';
    const limit = parseInt(req.query.limit) || 100;
    
    if (!q.trim()) {
      return res.json({ success: true, data: [], total: 0 });
    }
    
    const products = db.prepare(`
      SELECT * FROM new_products 
      WHERE name LIKE ? OR brand LIKE ?
      ORDER BY found_at DESC 
      LIMIT ?
    `).all(`%${q}%`, `%${q}%`, limit);
    
    res.json({ success: true, data: products, total: products.length });
  } catch (error) {
    logger.error('API /api/search: ' + error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Удалить товар из новых
app.delete('/api/new/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    
    db.prepare('DELETE FROM new_products WHERE id = ?').run(id);
    
    logger.db('Удалён товар из новых: ' + id);
    res.json({ success: true });
  } catch (error) {
    logger.error('API DELETE: ' + error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Очистить все новые
app.delete('/api/new', (req, res) => {
  try {
    db.exec('DELETE FROM new_products');
    
    logger.db('Очищена таблица новых товаров');
    res.json({ success: true });
  } catch (error) {
    logger.error('API DELETE /api/new: ' + error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Express error: ' + err.message);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// =====================================================
// ЗАПУСК
// =====================================================

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  logger.header('WB SCRAPER - Веб-сервер');
  logger.success(`Сервер запущен: http://localhost:${PORT}`);
  logger.info('Логи: ' + logger.getLogFile());
  logger.separator();
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.warning('Завершение работы...');
  process.exit(0);
});
