require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const TelegramBot = require("node-telegram-bot-api");
const path = require("path");
const db = require("./db");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── ENV CONFIG ───────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "YOUR_BOT_TOKEN_HERE";
const adminUser = process.env.ADMIN_USER || "YOUR_ADMIN_TELEGRAM_ID_HERE";
const APP_URL =
  process.env.APP_URL || "https://your-railway-url.up.railway.app";
const CBE_ACCOUNT = process.env.CBE_ACCOUNT || "YOUR_CBE_ACCOUNT_HERE";
const TELEBIRR_NUMBER =
  process.env.TELEBIRR_NUMBER || "YOUR_TELEBIRR_NUMBER_HERE";
const ACCOUNT_NAME = process.env.ACCOUNT_NAME || "YOUR FULL NAME HERE";

// ─── BOT SETUP ────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── STATE ────────────────────────────────────────────────────
let maintenanceMode = false;
let telegramId = null;
const awaitingUserIdInput = {};
const awaitingUserDepositAmountCbe = {};
const awaitingUserDepositAmountTelebirr = {};
const awaitingUserVerificationSmsCbe = {};
const awaitingUserVerificationSmsTelebirr = {};
const awaitingCbeAccountForWithdrawal = {};
const awaitingCbeNameForWithdrawal = {};
const awaitingCbeAmountForWithdrawal = {};
const broadcastMessageText = {};
const withdrawCbeDetails = {};

// ─── GAME STATE ───────────────────────────────────────────────
let gameState = {
  status: "waiting",
  players: {},
  cards: [],
  drawnNumbers: [],
  currentNumber: null,
  timer: null,
  countdownTimer: null,
  gameInterval: null,
};

// ─── WEBSOCKET ────────────────────────────────────────────────
const clients = new Map();

wss.on("connection", (ws) => {
  const clientId = uuidv4();
  clients.set(clientId, { ws, username: null, cardNumber: null });

  ws.send(
    JSON.stringify({
      type: "status",
      cards: gameState.cards,
      status: gameState.status,
    })
  );

  if (gameState.status === "playing") {
    ws.send(JSON.stringify({ type: "activeGame" }));
    ws.send(
      JSON.stringify({
        type: "gettingDrawnNumbers",
        drawnNumbers: gameState.drawnNumbers,
      })
    );
  }

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      const client = clients.get(clientId);

      if (data.type === "cardSelected") {
        const { number, username, balance } = data;

        if (parseInt(balance) < 10) {
          ws.send(JSON.stringify({ type: "lowBalance", u: username }));
          return;
        }

        if (gameState.cards.includes(number)) return;

        if (client.cardNumber) {
          gameState.cards = gameState.cards.filter(
            (c) => c !== client.cardNumber
          );
          broadcast({ type: "selectionCleared", number: client.cardNumber });
        }

        client.username = username;
        client.cardNumber = number;
        gameState.players[username] = number;
        gameState.cards.push(number);

        broadcast({
          type: "numberSelected",
          number,
          username,
          currentNumber: client.cardNumber,
        });

        if (
          gameState.status === "waiting" &&
          Object.keys(gameState.players).length >= 2 &&
          !gameState.countdownTimer
        ) {
          startCountdown();
        }
      } else if (data.type === "bingo") {
        handleBingo(data, ws);
      } else if (data.type === "refreshGameState") {
        ws.send(
          JSON.stringify({
            type: "gettingDrawnNumbers",
            drawnNumbers: gameState.drawnNumbers,
          })
        );
      }
    } catch (e) {
      console.error("WS message error:", e);
    }
  });

  ws.on("close", () => {
    const client = clients.get(clientId);
    if (client && client.cardNumber) {
      gameState.cards = gameState.cards.filter((c) => c !== client.cardNumber);
      if (client.username) delete gameState.players[client.username];
      broadcast({ type: "removeCardsOnLeave", n: client.cardNumber });
    }
    clients.delete(clientId);
  });
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(({ ws }) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function startCountdown() {
  let timeLeft = 15;
  gameState.countdownTimer = setInterval(() => {
    broadcast({ type: "timerBroadcast", timeLeft });
    timeLeft--;
    if (timeLeft < 0) {
      clearInterval(gameState.countdownTimer);
      gameState.countdownTimer = null;
      startGame();
    }
  }, 1000);
}

function startGame() {
  gameState.status = "playing";
  gameState.drawnNumbers = [];
  const players = { ...gameState.players };
  const playerCount = Object.keys(players).length;

  broadcast({ type: "gameStarted", users: players, players: playerCount });

  let count = 0;
  const numbers = shuffleNumbers();

  gameState.gameInterval = setInterval(() => {
    if (count >= numbers.length) {
      clearInterval(gameState.gameInterval);
      endGame();
      return;
    }
    const current = numbers[count];
    gameState.drawnNumbers.push(current);
    gameState.currentNumber = current;
    broadcast({ type: "numbersCalling", current, count: count + 1 });
    count++;
  }, 4000);
}

function shuffleNumbers() {
  const nums = Array.from({ length: 75 }, (_, i) => i + 1);
  for (let i = nums.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nums[i], nums[j]] = [nums[j], nums[i]];
  }
  return nums;
}

function handleBingo(data, ws) {
  const { c, username, n } = data;
  const drawn = gameState.drawnNumbers;

  const rows = [
    [c.b1, c.i1, c.n1, c.g1, c.o1],
    [c.b2, c.i2, c.n2, c.g2, c.o2],
    [c.b3, c.i3, null, c.g3, c.o3],
    [c.b4, c.i4, c.n4, c.g4, c.o4],
    [c.b5, c.i5, c.n5, c.g5, c.o5],
  ];

  const isWinner = rows.some((row) =>
    row.every((num) => num === null || drawn.includes(num))
  );

  if (isWinner) {
    const playerCount = Object.keys(gameState.players).length;
    const winAmount = Math.floor(playerCount * 10 * 0.8);

    const html = generateWinnerCardHtml(c, drawn);
    broadcast({ type: "bingo", u: username, html });

    clearInterval(gameState.gameInterval);

    setTimeout(() => {
      broadcast({ type: "gameFinished" });
      resetGame();
    }, 8000);

    saveGameResult(username, winAmount, playerCount);
  }
}

function generateWinnerCardHtml(c, drawn) {
  const cols = ["b", "i", "n", "g", "o"];
  const labels = ["B", "I", "N", "G", "O"];
  let html = `<div class='grid grid-cols-5 gap-1 text-center text-white text-xs'>`;
  labels.forEach((l) => {
    html += `<div class='font-bold bg-amber-600 rounded p-1'>${l}</div>`;
  });
  for (let r = 1; r <= 5; r++) {
    cols.forEach((col, ci) => {
      const key = `${col}${r}`;
      const val = c[key];
      if (r === 3 && ci === 2) {
        html += `<div class='bg-amber-400 rounded p-1 font-bold'>⭐</div>`;
      } else {
        const hit = val && drawn.includes(val);
        html += `<div class='rounded p-1 ${
          hit ? "bg-yellow-500 text-black font-bold" : "bg-gray-700"
        }'>${val || ""}</div>`;
      }
    });
  }
  html += `</div>`;
  return html;
}

function resetGame() {
  clearInterval(gameState.gameInterval);
  clearInterval(gameState.countdownTimer);
  gameState = {
    status: "waiting",
    players: {},
    cards: [],
    drawnNumbers: [],
    currentNumber: null,
    timer: null,
    countdownTimer: null,
    gameInterval: null,
  };
}

function endGame() {
  broadcast({ type: "gameFinished" });
  resetGame();
}

function saveGameResult(username, winAmount, playerCount) {
  const gameId = uuidv4();
  db.run(
    `INSERT INTO game_numbers (id, winner, win_amount, player_count, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
    [gameId, username, winAmount, playerCount],
    (err) => {
      if (err) console.error("Error saving game result:", err.message);
    }
  );
}

// ─── REST ENDPOINTS ───────────────────────────────────────────
app.get("/admin/users", (req, res) => { db.all("SELECT telegram_id, username, balance, bonus, played_games FROM users", [], (err, rows) => { res.json(rows); }); });
app.get("/getuserdetails", (req, res) => {
  const { userID } = req.query;
  db.get("SELECT * FROM users WHERE telegram_id = ?", [userID], (err, row) => {
    if (err || !row) return res.status(404).json({ error: "User not found" });
    res.json(row);
  });
});

app.get("/decreasePlayerBalance", (req, res) => {
  const { userID } = req.query;
  db.get(
    "SELECT balance, bonus FROM users WHERE telegram_id = ?",
    [userID],
    (err, row) => {
      if (err || !row) return res.status(404).json({ proceed: false });
      const total = row.balance + row.bonus;
      if (total < 10) return res.json({ proceed: false });

      if (row.balance >= 10) {
        db.run(
          "UPDATE users SET balance = balance - 10 WHERE telegram_id = ?",
          [userID],
          (err) => {
            if (err) return res.json({ proceed: false });
            res.json({ proceed: true });
          }
        );
      } else {
        db.run(
          "UPDATE users SET bonus = bonus - 10 WHERE telegram_id = ?",
          [userID],
          (err) => {
            if (err) return res.json({ proceed: false });
            res.json({ proceed: true });
          }
        );
      }
    }
  );
});

app.get("/getWinneerDetails", (req, res) => {
  const { userID, balance, isThisWinner } = req.query;
  if (isThisWinner === "true") {
    db.run(
      "UPDATE users SET balance = balance + ? WHERE telegram_id = ?",
      [parseInt(balance), userID],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
      }
    );
  }
  db.all(
    "SELECT username FROM users WHERE telegram_id = ?",
    [userID],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// ─── TELEGRAM BOT ─────────────────────────────────────────────
bot.onText(/\/start(.*)/, (msg, match) => {
  const chatId = msg.chat.id;
  const telegramIdd = msg.from.id.toString();
  const referrerId = match[1].trim();

  if (maintenanceMode) {
    bot.sendMessage(chatId, "🔧 ArifBet is under maintenance. Please wait.");
    return;
  }

  db.get(
    "SELECT * FROM users WHERE telegram_id = ?",
    [telegramIdd],
    (err, row) => {
      if (row) {
        bot.sendMessage(
          chatId,
          `🎰 Welcome back to ArifBet, ${row.username}!`,
          {
            reply_markup: {
              keyboard: [
                [{ text: "💰 My Balance" }, { text: "🎮 Play Now" }],
                [{ text: "👥 Invite Friends" }, { text: "📋 Rules" }],
              ],
              resize_keyboard: true,
            },
          }
        );
      } else {
        const username =
          msg.from.username ||
          `${msg.from.first_name || ""} ${msg.from.last_name || ""}`.trim();

        db.run(
          `INSERT INTO users (telegram_id, username, balance, bonus, played_games) VALUES (?, ?, 0, 0, 0)`,
          [telegramIdd, username],
          function (err) {
            if (err) {
              console.error("Insert error:", err.message);
              bot.sendMessage(chatId, "❌ Registration failed. Try again.");
              return;
            }

            if (referrerId && referrerId !== telegramIdd) {
              db.run(
                "UPDATE users SET bonus = bonus + 3 WHERE telegram_id = ?",
                [referrerId],
                (err) => {
                  if (!err) {
                    bot.sendMessage(
                      referrerId,
                      `🎉 Your friend joined ArifBet! You earned Br. 3 bonus.`
                    );
                  }
                }
              );
            }

            bot.sendMessage(
              chatId,
              `🎰 Welcome to ArifBet, ${username}!\n\nYou've been registered. Top up your balance to start playing!`,
              {
                reply_markup: {
                  keyboard: [
                    [{ text: "💰 My Balance" }, { text: "🎮 Play Now" }],
                    [{ text: "👥 Invite Friends" }, { text: "📋 Rules" }],
                  ],
                  resize_keyboard: true,
                },
              }
            );
          }
        );
      }
    }
  );
});

bot.onText(/\/balance/, (msg) => {
  const chatId = msg.chat.id;
  const telegramIdd = msg.from.id.toString();
  if (maintenanceMode) {
    bot.sendMessage(chatId, "🔧 ArifBet is under maintenance. Please wait.");
    return;
  }
  db.get(
    "SELECT balance, bonus FROM users WHERE telegram_id = ?",
    [telegramIdd],
    (err, row) => {
      if (err || !row) {
        bot.sendMessage(
          chatId,
          "❌ Could not fetch balance. Please register first by sending /start."
        );
        return;
      }
      bot.sendMessage(
        chatId,
        `💰 *ArifBet Balance*\n\nWithdrawable: Br. ${row.balance}\nBonus: Br. ${row.bonus}`,
        { parse_mode: "Markdown" }
      );
    }
  );
});

bot.onText(/\/invite/, (msg) => {
  const chatId = msg.chat.id;
  const telegramIdd = msg.from.id;
  if (maintenanceMode) {
    bot.sendMessage(chatId, "🔧 ArifBet is under maintenance. Please wait.");
    return;
  }
  bot.sendMessage(
    chatId,
    `🎉 *Invite & Earn with ArifBet!*\n\nShare your link and earn Br. 3 for every friend who joins!\n\nYour invite link:\nhttps://t.me/arifbet2_bot?start=${telegramIdd}\n\nBring friends, play together, win big! 🏆`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/rules/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `🎰 *ArifBet — Game Rules*\n\n1️⃣ Select any available card before the game starts.\n\n2️⃣ Numbers are called every 4 seconds — stay alert!\n\n3️⃣ Mark numbers on your card as they're called.\n\n4️⃣ Win by completing any full row (One Line).\n\n5️⃣ Hit the Bingo button first to claim your prize!\n\n🏆 First to complete wins the pot!\n\n🚫 All winners are verified automatically — no cheating.\n\n*Withdrawal rules:*\n• Minimum Br. 100 withdrawable balance\n• Must have 1+ successful deposit OR 20+ games played for bonus withdrawal`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/play/, (msg) => {
  const chatId = msg.chat.id;
  if (maintenanceMode) {
    bot.sendMessage(chatId, "🔧 ArifBet is under maintenance. Please wait.");
    return;
  }
  bot.sendMessage(chatId, "🎮 Tap below to enter ArifBet!", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🎰 Play ArifBet", web_app: { url: APP_URL } }],
      ],
    },
  });
});

bot.on("callback_query", (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  telegramId = query.from.id.toString();
  const data = query.data;

  if (maintenanceMode) {
    bot.sendMessage(
      telegramId,
      "🔧 ArifBet is under maintenance. Please wait."
    );
    return;
  }

  switch (true) {
    case data === "view_balance":
      db.get(
        "SELECT balance, bonus FROM users WHERE telegram_id = ?",
        [telegramId],
        (err, row) => {
          if (err || !row) {
            bot.sendMessage(
              chatId,
              "❌ Could not fetch balance. Please try again."
            );
            return;
          }
          bot.sendMessage(
            chatId,
            `💰 *ArifBet Balance*\n\nWithdrawable: Br. ${row.balance}\nBonus: Br. ${row.bonus}`,
            { parse_mode: "Markdown" }
          );
        }
      );
      break;

    case data === "join_game":
      bot.sendMessage(chatId, "🎮 Tap below to enter ArifBet!", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🎰 Play ArifBet", web_app: { url: APP_URL } }],
          ],
        },
      });
      break;

    case data === "game_rules":
      bot.sendMessage(
        chatId,
        `🎰 *ArifBet — Game Rules*\n\n1️⃣ Select any available card before the game starts.\n\n2️⃣ Numbers are called every 4 seconds — stay alert!\n\n3️⃣ Mark numbers on your card as they're called.\n\n4️⃣ Win by completing any full row (One Line).\n\n5️⃣ Hit the Bingo button first to claim your prize!\n\n🏆 First to complete wins the pot!\n\n🚫 All winners are verified automatically.`,
        { parse_mode: "Markdown" }
      );
      break;

    case data === "invite_friends":
      bot.sendMessage(
        chatId,
        `🎉 *Invite & Earn with ArifBet!*\n\nEarn Br. 3 for every friend who joins!\n\nYour invite link:\nhttps://t.me/arifbet2_bot?start=${telegramId}`,
        { parse_mode: "Markdown" }
      );
      break;

    case data === "chapa_pay":
      bot.sendMessage(chatId, "💳 Choose deposit method:", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Manual Transfer", callback_data: "manual_method" },
              { text: "Chapa Pay", callback_data: "chapa" },
            ],
          ],
        },
      });
      break;

    case data === "withdraw":
      db.get(
        "SELECT balance FROM users WHERE telegram_id = ?",
        [telegramId],
        (err, row) => {
          if (err || !row) {
            bot.sendMessage(
              chatId,
              "❌ Could not fetch balance. Please try again."
            );
            return;
          }
          if (parseInt(row.balance) < 100) {
            bot.sendMessage(chatId, "❌ Minimum withdrawal is Br. 100.");
            return;
          }
          db.get(
            "SELECT count(*) AS count FROM transactions WHERE userID = ? AND status = 'success'",
            [telegramId],
            (err, row) => {
              if (err || !row) return;
              if (row.count >= 1) {
                bot.sendMessage(chatId, "💸 Choose withdrawal method:", {
                  reply_markup: {
                    inline_keyboard: [
                      [
                        { text: "CBE", callback_data: "w_cbe" },
                        { text: "Telebirr", callback_data: "w_telebirr" },
                      ],
                    ],
                  },
                });
              } else {
                db.get(
                  "SELECT played_games FROM users WHERE telegram_id = ?",
                  [telegramId],
                  (err, row) => {
                    if (err || !row) return;
                    if (parseInt(row.played_games) >= 20) {
                      bot.sendMessage(chatId, "💸 Choose withdrawal method:", {
                        reply_markup: {
                          inline_keyboard: [
                            [
                              { text: "CBE", callback_data: "w_cbe" },
                              { text: "Telebirr", callback_data: "w_telebirr" },
                            ],
                          ],
                        },
                      });
                    } else {
                      bot.sendMessage(
                        chatId,
                        "⚠️ To withdraw bonus winnings, you need to play 20 games or make a deposit first."
                      );
                    }
                  }
                );
              }
            }
          );
        }
      );
      break;

    case data === "get_balance":
      bot.sendMessage(chatId, "📅 Select date range:", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Today", callback_data: "get_balance_today" },
              { text: "This Week", callback_data: "get_balance_week" },
            ],
            [
              { text: "This Month", callback_data: "get_balance_month" },
              { text: "All Time", callback_data: "get_balance_all" },
            ],
          ],
        },
      });
      break;

    case data === "get_games":
      getGameNumberCounts()
        .then((counts) => {
          bot.sendMessage(
            chatId,
            `\`\`\`\nGames Today:    ${counts.todayCount}\nAll Time Games: ${counts.totalCount}\`\`\``,
            { parse_mode: "Markdown" }
          );
        })
        .catch(console.error);
      break;

    case data === "get_users":
      bot.sendMessage(chatId, "👥 *User Search*", {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Search by ID", callback_data: "search_id" },
              { text: "Search by Name", callback_data: "search_name" },
            ],
            [
              { text: "All Users", callback_data: "search_all" },
              { text: "Last Winner", callback_data: "search_last_winner" },
            ],
            [{ text: "Leaderboard", callback_data: "search_leaderboard" }],
          ],
        },
      });
      break;

    case data === "get_balance_today":
      getBalanceByDate(getTodayString()).then((balance) => {
        bot.sendMessage(
          chatId,
          `\`\`\`\nBalance Today (${getTodayString()}): Br. ${balance}\`\`\``,
          { parse_mode: "Markdown" }
        );
      });
      break;

    case data === "get_balance_week":
      getProfitGroupedByDate(
        getMondayToToday().monday,
        getMondayToToday().today
      ).then((profits) => {
        bot.sendMessage(
          chatId,
          "📊 Weekly Profit:\n" + generateBoxTable(profits),
          {
            parse_mode: "Markdown",
          }
        );
      });
      break;

    case data === "get_balance_month":
      getProfitGroupedByDate(
        getMonthStartToToday().monthStart,
        getMonthStartToToday().today
      ).then((profits) => {
        bot.sendMessage(
          chatId,
          "📊 Monthly Profit:\n" + generateBoxTable(profits),
          {
            parse_mode: "Markdown",
          }
        );
      });
      break;

    case data === "get_balance_all":
      getBalanceAlltime().then((balance) => {
        bot.sendMessage(
          chatId,
          `\`\`\`\nAll Time Balance: Br. ${balance}\`\`\``,
          { parse_mode: "Markdown" }
        );
      });
      break;

    case data === "search_id":
      awaitingUserIdInput[chatId] = true;
      bot.sendMessage(chatId, "Please send the user's Telegram ID:");
      bot.answerCallbackQuery(query.id);
      break;

    case data === "manual_method":
      bot.sendMessage(chatId, "🏦 Choose bank:", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "CBE", callback_data: "cbe" },
              { text: "Telebirr", callback_data: "telebirr" },
            ],
          ],
        },
      });
      break;

    case data === "w_manual_method":
      bot.sendMessage(chatId, "🏦 Choose bank for withdrawal:", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "CBE", callback_data: "w_cbe" },
              { text: "Telebirr", callback_data: "w_telebirr" },
            ],
          ],
        },
      });
      break;

    case data === "cbe":
      awaitingUserDepositAmountCbe[chatId] = true;
      awaitingUserDepositAmountTelebirr[chatId] = false;
      bot.sendMessage(chatId, "💵 How much would you like to deposit? (Br.)");
      break;

    case data === "telebirr":
      awaitingUserDepositAmountTelebirr[chatId] = true;
      awaitingUserDepositAmountCbe[chatId] = false;
      bot.sendMessage(chatId, "💵 How much would you like to deposit? (Br.)");
      break;

    case data === "w_cbe":
      awaitingCbeAccountForWithdrawal[chatId] = true;
      awaitingUserDepositAmountCbe[chatId] = false;
      awaitingUserDepositAmountTelebirr[chatId] = false;
      bot.sendMessage(
        chatId,
        "🏦 Please enter your 13-digit CBE account number:"
      );
      break;

    case data === "w_telebirr":
      bot.sendMessage(
        chatId,
        "⚠️ Telebirr withdrawal temporarily unavailable. Please use CBE."
      );
      break;

    case data === "w_cbe_name":
      awaitingCbeNameForWithdrawal[chatId] = true;
      awaitingCbeAccountForWithdrawal[chatId] = false;
      bot.sendMessage(chatId, "👤 Please enter your full name:");
      break;

    case data === "w_cbe_amount":
      awaitingCbeAmountForWithdrawal[chatId] = true;
      awaitingCbeNameForWithdrawal[chatId] = false;
      bot.sendMessage(chatId, "💵 Enter withdrawal amount (Br. 100–1000):");
      break;

    case data.startsWith("deposit_user_"):
      const depositeData = data.replace("deposit_user_", "");
      const [userId, amount, id] = depositeData.split("_");
      updateUserBalanceByAdmin(userId, parseInt(amount), (err, result) => {
        if (err) {
          bot.sendMessage(adminUser, "❌ Error updating balance!").then(() => {
            bot.sendMessage(
              userId,
              "❌ Error processing transaction. Please contact admin."
            );
            bot.deleteMessage(adminUser, messageId);
          });
        } else {
          db.run(
            "UPDATE transactions SET status = ? WHERE id = ?",
            ["success", id],
            (err) => {
              if (err)
                return console.error("Error updating status:", err.message);
              bot.sendMessage(adminUser, "✅ Deposit approved!").then(() => {
                bot.sendMessage(
                  userId,
                  `✅ Deposit successful! New balance: Br. ${result.new_balance}`
                );
                bot.deleteMessage(adminUser, messageId);
              });
            }
          );
        }
      });
      break;

    case data === "verify_telebirr":
      awaitingUserVerificationSmsTelebirr[chatId] = true;
      awaitingUserDepositAmountTelebirr[chatId] = false;
      bot.sendMessage(chatId, "📲 Please send the SMS you received from 127:");
      break;

    case data === "broadcast_message":
      broadcastMessageText[chatId] = true;
      bot.sendMessage(
        adminUser,
        "📢 Enter the message to broadcast to all users:"
      );
      break;

    default:
      break;
  }
});

bot.on("message", async (msg) => {
  const text = msg.text;
  const chatId = msg.chat.id;

  if (!text) return;

  if (maintenanceMode) {
    bot.sendMessage(chatId, "🔧 ArifBet is under maintenance. Please wait.");
    return;
  }

  // Keyboard buttons
  if (text === "💰 My Balance") {
    const tid = msg.from.id.toString();
    db.get(
      "SELECT balance, bonus FROM users WHERE telegram_id = ?",
      [tid],
      (err, row) => {
        if (err || !row) {
          bot.sendMessage(chatId, "❌ Could not fetch balance.");
          return;
        }
        bot.sendMessage(
          chatId,
          `💰 *ArifBet Balance*\n\nWithdrawable: Br. ${row.balance}\nBonus: Br. ${row.bonus}`,
          { parse_mode: "Markdown" }
        );
      }
    );
  } else if (text === "🎮 Play Now") {
    bot.sendMessage(chatId, "🎮 Tap below to enter ArifBet!", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎰 Play ArifBet", web_app: { url: APP_URL } }],
        ],
      },
    });
  } else if (text === "👥 Invite Friends") {
    const tid = msg.from.id;
    bot.sendMessage(
      chatId,
      `🎉 *Invite & Earn!*\n\nEarn Br. 3 for every friend who joins ArifBet!\n\nYour link:\nhttps://t.me/arifbet2_bot?start=${tid}`,
      { parse_mode: "Markdown" }
    );
  } else if (text === "📋 Rules") {
    bot.sendMessage(
      chatId,
      `🎰 *ArifBet Rules*\n\n• Select a card before game starts\n• Numbers called every 4s\n• Complete any row to win\n• Hit Bingo first!\n• Min withdrawal: Br. 100`,
      { parse_mode: "Markdown" }
    );
  }

  // Admin panel
  if (text === "📊 Get Balance" && chatId.toString() === adminUser) {
    bot.sendMessage(chatId, "📅 Select date range:", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Today", callback_data: "get_balance_today" },
            { text: "This Week", callback_data: "get_balance_week" },
          ],
          [
            { text: "This Month", callback_data: "get_balance_month" },
            { text: "All Time", callback_data: "get_balance_all" },
          ],
        ],
      },
    });
  } else if (text === "🎮 Games" && chatId.toString() === adminUser) {
    getGameNumberCounts().then((counts) => {
      bot.sendMessage(
        chatId,
        `\`\`\`\nGames Today:    ${counts.todayCount}\nAll Time Games: ${counts.totalCount}\`\`\``,
        { parse_mode: "Markdown" }
      );
    });
  } else if (text === "👥 Users" && chatId.toString() === adminUser) {
    bot.sendMessage(chatId, "👥 *Users*", {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Search by ID", callback_data: "search_id" },
            { text: "Search by Name", callback_data: "search_name" },
          ],
          [
            { text: "All Users", callback_data: "search_all" },
            { text: "Last Winner", callback_data: "search_last_winner" },
          ],
          [{ text: "Leaderboard", callback_data: "search_leaderboard" }],
        ],
      },
    });
  }

  // Awaiting inputs
  if (awaitingUserIdInput[chatId] && /^\d+$/.test(text.trim())) {
    delete awaitingUserIdInput[chatId];
    try {
      const user = await getUserByTelegramId(text.trim());
      if (user) {
        bot.sendMessage(chatId, generateUserBoxTable(user), {
          parse_mode: "Markdown",
        });
      } else {
        bot.sendMessage(chatId, `❌ No user found with ID: ${text.trim()}`);
      }
    } catch (err) {
      bot.sendMessage(chatId, "⚠️ Database error.");
    }
  }

  if (awaitingUserDepositAmountCbe[chatId] && /^\d+$/.test(text.trim())) {
    awaitingUserDepositAmountCbe[chatId] = false;
    const tx_ref = uuidv4();
    const tid = telegramId || msg.from.id.toString();
    db.run(
      "INSERT INTO transactions (tx_ref, userID, amount, status, method) VALUES (?, ?, ?, ?, ?)",
      [tx_ref, tid, parseInt(text), "pending", "cbe"],
      function (err) {
        if (err) return console.error("Transaction insert error:", err.message);
        bot
          .sendMessage(
            chatId,
            `🏦 *Deposit Instructions — CBE*\n\n🔹 Bank: CBE\n🔢 Account: ${CBE_ACCOUNT}\n👤 Name: ${ACCOUNT_NAME}\n\nAfter payment, click below to verify.`,
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "✅ I've Sent the Payment",
                      callback_data: "verify_cbe",
                    },
                  ],
                ],
              },
            }
          )
          .then(() => {
            bot.sendMessage(
              adminUser,
              `💰 New CBE deposit request\nFrom: ${chatId}\nAmount: Br. ${text}`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "✅ Approve",
                        callback_data: `deposit_user_${chatId}_${text}_${this.lastID}`,
                      },
                    ],
                  ],
                },
              }
            );
          });
      }
    );
  }

  if (awaitingUserDepositAmountTelebirr[chatId] && /^\d+$/.test(text.trim())) {
    awaitingUserDepositAmountTelebirr[chatId] = false;
    const tx_ref = uuidv4();
    const tid = telegramId || msg.from.id.toString();
    db.run(
      "INSERT INTO transactions (tx_ref, userID, amount, status, method) VALUES (?, ?, ?, ?, ?)",
      [tx_ref, tid, parseInt(text), "pending", "telebirr"],
      function (err) {
        if (err) return console.error("Transaction insert error:", err.message);
        bot
          .sendMessage(
            chatId,
            `🏦 *Deposit Instructions — Telebirr*\n\n🔹 Method: Telebirr\n📱 Phone: ${TELEBIRR_NUMBER}\n👤 Name: ${ACCOUNT_NAME}\n\nAfter payment, send the SMS from 127 below.`,
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "📲 Send SMS from 127",
                      callback_data: "verify_telebirr",
                    },
                  ],
                ],
              },
            }
          )
          .then(() => {
            bot.sendMessage(
              adminUser,
              `💰 New Telebirr deposit request\nFrom: ${chatId}\nAmount: Br. ${text}`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "✅ Approve",
                        callback_data: `deposit_user_${chatId}_${text}_${this.lastID}`,
                      },
                    ],
                  ],
                },
              }
            );
          });
      }
    );
  }

  if (awaitingUserVerificationSmsTelebirr[chatId]) {
    awaitingUserVerificationSmsTelebirr[chatId] = false;
    bot
      .sendMessage(adminUser, `📲 Telebirr SMS from ${chatId}:\n${text}`)
      .then(() => {
        bot.sendMessage(
          chatId,
          "✅ Verification sent. Please wait for admin confirmation."
        );
      });
  }

  if (awaitingCbeAccountForWithdrawal[chatId]) {
    awaitingCbeAccountForWithdrawal[chatId] = false;
    if (/^\d{13}$/.test(text.trim())) {
      withdrawCbeDetails[chatId] = [text.trim()];
      bot.sendMessage(chatId, "✅ Account received.", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Continue", callback_data: "w_cbe_name" }],
          ],
        },
      });
    } else {
      bot.sendMessage(
        chatId,
        "❌ Invalid account number. Must be 13 digits. Please try again."
      );
    }
  }

  if (awaitingCbeNameForWithdrawal[chatId]) {
    awaitingCbeNameForWithdrawal[chatId] = false;
    if (!withdrawCbeDetails[chatId]) withdrawCbeDetails[chatId] = [];
    withdrawCbeDetails[chatId].push(text.trim());
    bot.sendMessage(chatId, "✅ Name saved.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Continue", callback_data: "w_cbe_amount" }],
        ],
      },
    });
  }

  if (awaitingCbeAmountForWithdrawal[chatId]) {
    awaitingCbeAmountForWithdrawal[chatId] = false;
    if (
      /^\d+$/.test(text.trim()) &&
      parseInt(text) >= 100 &&
      parseInt(text) <= 1000
    ) {
      withdrawCbeDetails[chatId].push(text.trim());
      const [account, name, amount] = withdrawCbeDetails[chatId];
      bot
        .sendMessage(
          chatId,
          "⏳ Withdrawal request submitted. Please wait for admin approval."
        )
        .then(() => {
          bot.sendMessage(
            adminUser,
            `💸 Withdrawal Request\n\nMethod: CBE\nAccount: ${account}\nName: ${name}\nAmount: Br. ${amount}\nUser: ${chatId}`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "✅ Approve", callback_data: "w_cbe_approve" }],
                ],
              },
            }
          );
        });
      withdrawCbeDetails[chatId] = [];
    } else {
      bot.sendMessage(
        chatId,
        "❌ Amount must be between Br. 100 and Br. 1000."
      );
      withdrawCbeDetails[chatId] = [];
    }
  }

  if (broadcastMessageText[adminUser] && chatId.toString() === adminUser) {
    broadcastMessageText[adminUser] = false;
    broadcastMessage(text);
  }
});

// ─── HELPER FUNCTIONS ─────────────────────────────────────────
function getTodayString() {
  const d = new Date();
  return `${d.getFullYear()}-${(d.getMonth() + 1)
    .toString()
    .padStart(2, "0")}-${d.getDate().toString().padStart(2, "0")}`;
}

function getMondayToToday() {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - today.getDay() + 1);
  const fmt = (d) =>
    `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d
      .getDate()
      .toString()
      .padStart(2, "0")}`;
  return { monday: fmt(monday), today: fmt(today) };
}

function getMonthStartToToday() {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const fmt = (d) =>
    `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d
      .getDate()
      .toString()
      .padStart(2, "0")}`;
  return { monthStart: fmt(monthStart), today: fmt(today) };
}

function getBalanceByDate(date) {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE status = 'success' AND date(created_at) = ?",
      [date],
      (err, row) => {
        if (err) return reject(err);
        resolve(row ? row.total : 0);
      }
    );
  });
}

function getBalanceAlltime() {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE status = 'success'",
      [],
      (err, row) => {
        if (err) return reject(err);
        resolve(row ? row.total : 0);
      }
    );
  });
}

function getProfitGroupedByDate(start, end) {
  return new Promise((resolve, reject) => {
    db.all(
      "SELECT date(created_at) AS day, SUM(amount) AS total FROM transactions WHERE status = 'success' AND date(created_at) BETWEEN ? AND ? GROUP BY day ORDER BY day",
      [start, end],
      (err, rows) => {
        if (err) return reject(err);
        const result = {};
        rows.forEach((r) => (result[r.day] = r.total));
        resolve(result);
      }
    );
  });
}

function getGameNumberCounts() {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT COUNT(*) AS totalCount FROM game_numbers",
      [],
      (err, totalRow) => {
        if (err) return reject(err);
        db.get(
          "SELECT COUNT(*) AS todayCount FROM game_numbers WHERE date(created_at) = date('now')",
          [],
          (err, todayRow) => {
            if (err) return reject(err);
            resolve({
              totalCount: totalRow ? totalRow.totalCount : 0,
              todayCount: todayRow ? todayRow.todayCount : 0,
            });
          }
        );
      }
    );
  });
}

function generateBoxTable(profits) {
  if (!profits || Object.keys(profits).length === 0) return "```\nNo data\n```";
  let table = "```\n";
  table += "Date       | Profit\n";
  table += "-----------|--------\n";
  Object.entries(profits).forEach(([day, total]) => {
    table += `${day} | Br. ${total}\n`;
  });
  table += "```";
  return table;
}

function getUserByTelegramId(id) {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM users WHERE telegram_id = ?", [id], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function generateUserBoxTable(user) {
  const entries = Object.entries(user).map(([key, value]) => [
    key,
    String(value),
  ]);
  const colWidths = [
    Math.max(...entries.map(([k]) => k.length)),
    Math.max(...entries.map(([, v]) => v.length)),
  ];
  const line = (l, m, r) =>
    l + colWidths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const row = (cells) =>
    "│" + cells.map((c, i) => ` ${c.padEnd(colWidths[i])} `).join("│") + "│";
  return (
    "```\n" +
    line("┌", "┬", "┐") +
    "\n" +
    entries.map(row).join("\n") +
    "\n" +
    line("└", "┴", "┘") +
    "\n```"
  );
}

function updateUserBalanceByAdmin(telegramId, amount, callback) {
  db.get(
    "SELECT balance FROM users WHERE telegram_id = ?",
    [telegramId],
    (err, row) => {
      if (err) return callback(err);
      if (!row) return callback(new Error("User not found"));
      const newBalance = row.balance + amount;
      db.run(
        "UPDATE users SET balance = ? WHERE telegram_id = ?",
        [newBalance, telegramId],
        function (err) {
          if (err) return callback(err);
          callback(null, { telegram_id: telegramId, new_balance: newBalance });
        }
      );
    }
  );
}

function broadcastMessage(messageText) {
  db.all("SELECT telegram_id FROM users", [], (err, rows) => {
    if (err) return console.error("Broadcast DB error:", err);
    rows.forEach((user) => {
      bot
        .sendMessage(user.telegram_id, `📢 ${messageText}`)
        .catch((e) =>
          console.error(`Failed to send to ${user.telegram_id}:`, e.message)
        );
    });
  });
}

// ─── START SERVER ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎰 ArifBet server running on port ${PORT}`);
  console.log(`🌐 App URL: ${APP_URL}`);
});
