const path = require("path");
const sqlite3 = require("sqlite3").verbose();
require("dotenv").config();

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, "piasa_online.db");

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Error opening database", err.message);
  } else {
    console.log("Connected to SQLite database:", dbPath);
  }
});

module.exports = db;
