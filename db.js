function initializeDB() {
  db.serialize(() => {
    db.run(`DROP TABLE IF EXISTS users`);
    db.run(`DROP TABLE IF EXISTS transactions`);
    db.run(`DROP TABLE IF EXISTS game_numbers`);

    db.run(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE,
      username TEXT,
      balance INTEGER DEFAULT 0,
      bonus INTEGER DEFAULT 0,
      played_games INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_ref TEXT,
      userID TEXT,
      amount INTEGER,
      status TEXT DEFAULT 'pending',
      method TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE game_numbers (
      id TEXT PRIMARY KEY,
      winner TEXT,
      win_amount INTEGER,
      player_count INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  });
}
