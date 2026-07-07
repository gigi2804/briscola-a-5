const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

const io = new Server(server, { pingTimeout: 60000, pingInterval: 25000, connectTimeout: 30000 });
const path = require('path');
const PORT = process.env.PORT || 3000;

// NOTA: Rimossi TensorFlow e la rete neurale perché incompatibili con le regole della Briscola a 5

app.use(express.static(__dirname));
app.use('/carte', express.static(path.join(__dirname, 'carte')));
app.use('/sticker', express.static(path.join(__dirname, 'sticker')));

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

console.log("SERVER AVVIATO: Briscola a 5 (A Chiamata)");

const rooms = {}; 
const SUITS = ['denari', 'coppe', 'spade', 'bastoni'];
const BRISCOLA_POINTS = { 1: 11, 3: 10, 10: 4, 9: 3, 8: 2, 7: 0, 6: 0, 5: 0, 4: 0, 2: 0 };
const BRISCOLA_HIERARCHY = { 1: 100, 3: 90, 10: 80, 9: 70, 8: 60, 7: 50, 6: 40, 5: 30, 4: 20, 2: 10 };

function createRoomState() {
    return {
        players: [], deck: [], tableCards: [],
        gameState: "LOBBY", // LOBBY, BIDDING, CALLING, PLAYING
        currentPlayerIndex: 0, dealerIndex: 0, firstPlayerIndex: 0,
        isProcessing: false,
        botCounter: 1,
        currentMaxBid: 60,
        highestBidderId: null,
        briscolaSuit: null,
        calledCard: null,
        partnerId: null
    };
}

function createDeck() {
  let d = [];
  SUITS.forEach(suit => { [1,2,3,4,5,6,7,8,9,10].forEach(v => d.push({ suit, value: v, id: `${suit}-${v}` })); });
  return d;
}
function shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }

function getCardPowerBriscola(card, leadingSuit, briscolaSuit) {
    let power = BRISCOLA_HIERARCHY[card.value];
    if (card.suit === briscolaSuit) { power += 1000; } 
    else if (card.suit !== leadingSuit) { power = -1; }
    return power;
}

io.on('connection', (socket) => {

    socket.on('addBot', () => {
        const roomName = socket.roomName; if (!roomName || !rooms[roomName]) return; const room = rooms[roomName];
        if (room.players.length >= 5) return socket.emit('warning', 'Il tavolo della Briscola a 5 prevede esattamente 5 posti!');
        const botId = "BOT_" + Math.random().toString(36).substr(2, 9);
        room.players.push({ id: botId, name: "Bot_" + room.botCounter++, hand: [], bid: null, tricksWon: 0, isBot: true, passedBidding: false });
        broadcastUpdate(roomName);
    });

    socket.on('removeBot', () => {
        const roomName = socket.roomName; if (!roomName || !rooms[roomName]) return; const room = rooms[roomName];
        for (let i = room.players.length - 1; i >= 0; i--) {
            if (room.players[i].isBot) { room.players.splice(i, 1); room.botCounter--; break; }
        }
        broadcastUpdate(roomName);
    });

    socket.on('disconnect', () => { handleLeave(socket); });
    socket.on('leaveRoom', () => { if (socket.roomName) socket.leave(socket.roomName); handleLeave(socket); });
    socket.on('leaveGame', () => { handleLeave(socket); });

    function handleLeave(sock) {
        try {
            const roomName = sock.roomName; if (!roomName || !rooms[roomName]) return; const room = rooms[roomName];
            const index = room.players.findIndex(x => x.id === sock.id);
            if (index !== -1) {
                room.players.splice(index, 1);
                io.to(roomName).emit('chatMessage', { name: "SISTEMA", text: `👋 Un giocatore è uscito.`, id: "SYS" });
                if (room.players.filter(p => !p.isBot).length === 0) { delete rooms[roomName]; return; }
                if (room.gameState !== "LOBBY") {
                    io.to(roomName).emit('statusMsg', "⚠️ Partita interrotta (un giocatore ha abbandonato). Ritorno in Lobby...");
                    setTimeout(() => resetGame(roomName), 3000);
                } else { broadcastUpdate(roomName); }
            }
        } catch (e) { console.error(e); }
    }

    socket.on('join', (data) => {
        const { name, roomName } = data; if(!name || !roomName) return;
        const sanitizedRoom = roomName.trim().toUpperCase(); socket.join(sanitizedRoom); socket.roomName = sanitizedRoom;
        if (!rooms[sanitizedRoom]) rooms[sanitizedRoom] = createRoomState();
        const room = rooms[sanitizedRoom];
        
        if (room.players.length >= 5) return socket.emit('errorMsg', 'Tavolo Pieno! La Briscola a 5 si gioca in 5.');
        room.players.push({ id: socket.id, name, hand: [], bid: null, tricksWon: 0, isBot: false, passedBidding: false });
        broadcastUpdate(sanitizedRoom);
    });

    socket.on('startGame', () => {
        const roomName = socket.roomName; if (!roomName || !rooms[roomName]) return; const room = rooms[roomName];
        if (room.players[0].id !== socket.id) return;
        if (room.players.length !== 5) return socket.emit('errorMsg', 'Devono esserci esattamente 5 giocatori (aggiungi Bot se necessario)!');
        startRound(roomName);
    });
    
    socket.on('sendChat', (data) => {
        const roomName = socket.roomName; if (!roomName || !rooms[roomName]) return; const room = rooms[roomName];
        const player = room.players.find(p => p.id === socket.id);
        io.to(roomName).emit('chatMessage', { name: player ? player.name : "?", text: data.text, type: data.type || 'text', id: socket.id });
    });
  
    socket.on('placeBid', (bid) => { 
        const roomName = socket.roomName; if (!roomName || !rooms[roomName]) return; const room = rooms[roomName];
        if(room.gameState !== "BIDDING" || room.isProcessing || room.players[room.currentPlayerIndex].id !== socket.id) return; 
        
        const p = room.players.find(x=>x.id===socket.id);
        if (bid === 'PASSO') {
            p.passedBidding = true;
        } else {
            let val = parseInt(bid);
            if (val > room.currentMaxBid && val <= 120) {
                room.currentMaxBid = val;
                room.highestBidderId = p.id;
                p.bid = val;
            }
        }
        broadcastUpdate(roomName); nextTurnBidding(roomName); 
    });

    socket.on('makeCall', (data) => {
        const roomName = socket.roomName; if (!roomName || !rooms[roomName]) return; const room = rooms[roomName];
        if(room.gameState !== "CALLING" || room.players[room.currentPlayerIndex].id !== socket.id) return;
        
        room.briscolaSuit = data.suit;
        room.calledCard = { value: data.value, suit: data.suit };
        
        // Trova il compagno segreto
        room.partnerId = null;
        room.players.forEach(p => {
            if (p.hand.find(c => c.value === data.value && c.suit === data.suit)) { room.partnerId = p.id; }
        });
        
        io.to(roomName).emit('briscolaUpdate', { suit: data.suit, value: data.value });
        
        room.gameState = "PLAYING";
        // MODIFICA: Il primo a giocare è chi ha vinto l'asta (il chiamante)
        room.firstPlayerIndex = room.players.findIndex(p => p.id === socket.id);
        room.currentPlayerIndex = room.firstPlayerIndex;
        
        broadcastUpdate(roomName); updateGameState(roomName);
    });
  
    socket.on('playCard', (data) => { 
        const roomName = socket.roomName; if (!roomName || !rooms[roomName]) return; const room = rooms[roomName]; 
        if(room.gameState !== "PLAYING" || room.isProcessing || room.players[room.currentPlayerIndex].id !== socket.id) return; 
        
        const p = room.players.find(x=>x.id===socket.id);
        const c = p.hand.splice(data.cardIndex, 1)[0]; 
        
        room.tableCards.push({ playerId: p.id, card: c, playerName: p.name }); 
        io.to(roomName).emit('tableUpdate', room.tableCards); 
        io.to(p.id).emit('updateHand', p.hand); 
        nextTurnPlaying(roomName); 
    });
});

function handleBotTurn(roomName) {
    const room = rooms[roomName];
    if (!room || room.isProcessing) return;
    const p = room.players[room.currentPlayerIndex];
    if (!p || !p.isBot) return;

    room.isProcessing = true;
    setTimeout(() => {
        if (!rooms[roomName]) return;
        room.isProcessing = false;

        if (room.gameState === "BIDDING") {
            // Bot logica asta: passa quasi sempre per non rovinare il gioco agli umani, oppure fa un piccolo rilancio iniziale
            if (room.currentMaxBid < 65 && Math.random() > 0.5) {
                let val = room.currentMaxBid + 1;
                room.currentMaxBid = val; room.highestBidderId = p.id; p.bid = val;
            } else {
                p.passedBidding = true;
            }
            broadcastUpdate(roomName); nextTurnBidding(roomName);

        } else if (room.gameState === "CALLING") {
            // Se il bot vince l'asta, chiama un seme e una carta a caso (spesso il 3 per non tirarsi la zappa sui piedi)
            const suits = ['denari', 'coppe', 'spade', 'bastoni'];
            const calledSuit = suits[Math.floor(Math.random()*suits.length)];
            room.briscolaSuit = calledSuit; room.calledCard = { value: 3, suit: calledSuit };
            
            room.players.forEach(pl => { if (pl.hand.find(c => c.value === 3 && c.suit === calledSuit)) { room.partnerId = pl.id; }});
            
            io.to(roomName).emit('briscolaUpdate', { suit: calledSuit, value: 3 });
            
            room.gameState = "PLAYING";
            room.firstPlayerIndex = (room.dealerIndex + 1) % 5; room.currentPlayerIndex = room.firstPlayerIndex;
            broadcastUpdate(roomName); updateGameState(roomName);

        } else if (room.gameState === "PLAYING") {
            // Logica Bot Base per giocare: Gioca una carta a caso
            if (p.hand.length === 0) return;
            let chosenIdx = Math.floor(Math.random() * p.hand.length);
            const c = p.hand.splice(chosenIdx, 1)[0];
            room.tableCards.push({ playerId: p.id, card: c, playerName: p.name });
            io.to(roomName).emit('tableUpdate', room.tableCards);
            nextTurnPlaying(roomName);
        }
    }, 1500);
}

function broadcastUpdate(roomName) {
    const room = rooms[roomName]; if(!room) return;
    const hostPlayer = room.players.find(x => !x.isBot);
    const hostId = hostPlayer ? hostPlayer.id : null;
    room.players.forEach(p => {
        if (!p.isBot) {
            io.to(p.id).emit('updatePlayers', {
                list: room.players.map((pl, idx) => ({ id: pl.id, name: pl.name, isBot: pl.isBot, tricksWon: pl.tricksWon, passedBidding: pl.passedBidding, bid: pl.bid, isDealer: (idx === room.dealerIndex), handCount: pl.hand.length })),
                isHost: (p.id === hostId) 
            });
        }
    });
    if (room.gameState !== "LOBBY") {
        io.to(roomName).emit('tableUpdate', room.tableCards);
        if (room.players[room.currentPlayerIndex]) {
            io.to(roomName).emit('turnUpdate', { playerId: room.players[room.currentPlayerIndex].id, phase: room.gameState, currentMaxBid: room.currentMaxBid });
        }
    }
}

function startRound(roomName) {
  const room = rooms[roomName];
  room.deck = shuffle(createDeck()); room.tableCards = []; room.isProcessing = false;
  room.gameState = "BIDDING"; room.currentMaxBid = 60; room.highestBidderId = null;
  room.briscolaSuit = null; room.calledCard = null; room.partnerId = null;
  io.to(roomName).emit('briscolaUpdate', {suit: null, value: null});

  room.players.forEach(p => { 
      p.bid = null; p.tricksWon = 0; p.passedBidding = false;
      p.hand = room.deck.splice(0, 8);
      p.hand.sort((a, b) => { 
    const sOrder = {'bastoni': 1, 'spade': 2, 'coppe': 3, 'denari': 4}; 
    if (sOrder[a.suit] !== sOrder[b.suit]) return sOrder[a.suit] - sOrder[b.suit]; 
    // Ordina dal più forte al più debole usando BRISCOLA_HIERARCHY
    return BRISCOLA_HIERARCHY[b.value] - BRISCOLA_HIERARCHY[a.value]; 
    });
  });
  
  room.players.forEach(p => { if (!p.isBot) io.to(p.id).emit('updateHand', p.hand); });
  room.firstPlayerIndex = (room.dealerIndex + 1) % 5; room.currentPlayerIndex = room.firstPlayerIndex; 
  broadcastUpdate(roomName); updateGameState(roomName);
}

function nextTurnBidding(roomName) {
    const room = rooms[roomName];
    let activeBidders = room.players.filter(p => !p.passedBidding);
    
    // Se tutti passano al primo giro tranne l'ultimo
    if (activeBidders.length === 1 && room.highestBidderId === null) {
        room.highestBidderId = activeBidders[0].id;
        room.currentMaxBid = 60; // Se nessuno ha rilanciato, vince la base
    }

    if (activeBidders.length <= 1) {
        // Asta Finita
        let winner = room.players.find(p => p.id === room.highestBidderId);
        if(!winner) winner = activeBidders[0] || room.players[room.firstPlayerIndex]; // Failsafe
        
        room.gameState = "CALLING";
        room.currentPlayerIndex = room.players.findIndex(p => p.id === winner.id);
        
        broadcastUpdate(roomName);
        if (winner.isBot) handleBotTurn(roomName); else io.to(winner.id).emit('promptCall');
        return;
    }
    
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % 5;
    while (room.players[room.currentPlayerIndex].passedBidding) { room.currentPlayerIndex = (room.currentPlayerIndex + 1) % 5; }
    updateGameState(roomName);
}

function nextTurnPlaying(roomName) {
    const room = rooms[roomName];
    if (room.tableCards.length === 5) { evaluateTrick(roomName); } 
    else { room.currentPlayerIndex = (room.currentPlayerIndex + 1) % 5; updateGameState(roomName); }
}

function evaluateTrick(roomName) {
    const room = rooms[roomName]; room.isProcessing = true;
    let leadingSuit = room.tableCards[0].card.suit; 
    let winner = room.tableCards[0];
    let maxP = getCardPowerBriscola(winner.card, leadingSuit, room.briscolaSuit);
    let trickPoints = BRISCOLA_POINTS[winner.card.value];

    for (let i = 1; i < room.tableCards.length; i++) { 
        let p = getCardPowerBriscola(room.tableCards[i].card, leadingSuit, room.briscolaSuit); 
        trickPoints += BRISCOLA_POINTS[room.tableCards[i].card.value];
        if (p > maxP) { winner = room.tableCards[i]; maxP = p; } 
    }
    
    let wPlayer = room.players.find(p => p.id === winner.playerId);
    if(wPlayer) wPlayer.tricksWon += trickPoints; 
    io.to(roomName).emit('trickResult', `Presa: ${wPlayer?.name} (+${trickPoints} pt)`); 
    
    setTimeout(() => {
        if(!rooms[roomName]) return;
        const r = rooms[roomName]; 
        broadcastUpdate(roomName);
        r.tableCards = []; io.to(roomName).emit('tableUpdate', []); 
        r.currentPlayerIndex = r.players.findIndex(p => p.id === winner.playerId);
        
        if (r.players[0].hand.length === 0) endRoundLogic(roomName); 
        else { r.isProcessing = false; updateGameState(roomName); }
    }, 3500); 
}

function endRoundLogic(roomName) {
    const room = rooms[roomName]; room.isProcessing = true; 
    const caller = room.players.find(p => p.id === room.highestBidderId);
    const partner = room.players.find(p => p.id === room.partnerId);
    
    let pointsAttacking = caller.tricksWon + (partner && partner.id !== caller.id ? partner.tricksWon : 0);
    let win = pointsAttacking >= room.currentMaxBid;
    
    let reportMsg = `📊 <b>FINE PARTITA</b> 📊<br><br>`;
    reportMsg += `Chiamante: <b>${caller.name}</b> (Obiettivo: ${room.currentMaxBid})<br>`;
    if (partner) reportMsg += `Compagno: <b>${partner.name}</b><br>`;
    reportMsg += `Punti Totali Fatti: <b>${pointsAttacking}</b>/120<br><br>`;
    
    if (win) reportMsg += `<span style='color:#00ff00; font-size:18px;'>🎉 I CHIAMANTI VINCONO! 🎉</span>`;
    else reportMsg += `<span style='color:#ff4444; font-size:18px;'>🛡️ I DIFENSORI VINCONO! 🛡️</span>`;

    io.to(roomName).emit('statusMsg', reportMsg);
    
    setTimeout(() => {
        if(rooms[roomName]) {
            // Avanziamo il mazziere per la prossima partita
            room.dealerIndex = (room.dealerIndex + 1) % 5;
            
            // Invece di avviare un nuovo round, resettiamo il tavolo e torniamo in lobby
            resetGame(roomName);
        }
    }, 8000); // Aspetta 8 secondi per far leggere i risultati a schermo, poi torna in lobby
}

function resetGame(roomName) { 
    if(!rooms[roomName]) return; const r = rooms[roomName]; 
    r.gameState="LOBBY"; r.tableCards=[]; r.isProcessing=false; 
    r.players.forEach(p => { p.hand=[]; p.bid=null; p.tricksWon=0; p.passedBidding=false; }); 
    io.to(roomName).emit('backToLobby'); broadcastUpdate(roomName); 
}

function updateGameState(roomName) { 
    const r = rooms[roomName]; if(!r) return; 
    let msg = "";
    if(r.gameState === "BIDDING") msg = `Asta: Tocca a ${r.players[r.currentPlayerIndex].name}`;
    else if (r.gameState === "CALLING") {
        const winner = r.players.find(p => p.id === r.highestBidderId);
        msg = `🏆 ${winner ? winner.name : 'Qualcuno'} vince l'asta a ${r.currentMaxBid}!<br><span style="font-size:12px">Attendi che scelga la Briscola...</span>`;
    }
    else msg = `Gioca: ${r.players[r.currentPlayerIndex].name}`;
    io.to(roomName).emit('statusMsg', msg); 
    io.to(roomName).emit('turnUpdate', { playerId: r.players[r.currentPlayerIndex].id, phase: r.gameState, currentMaxBid: r.currentMaxBid }); 
    handleBotTurn(roomName);
}

server.listen(PORT, () => console.log(`SERVER BRISCOLA PORT ${PORT}`));