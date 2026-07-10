const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const tf = require('@tensorflow/tfjs');
const fs = require('fs');

// --- CARICAMENTO DEL MODELLO IA MANUALE ---
let botBrain = null;
let bidBrain = null;

// Aggiungi la funzione utility per l'Asta
function getHandVector(hand) {
    const vector = new Array(40).fill(0);
    hand.forEach(c => vector[getCardIndex(c)] = 1);
    return vector;
}

async function loadBotModel() {
    // 1. CARICAMENTO CERVELLO DI GIOCO (botBrain)
    try {
        const modelJson = JSON.parse(fs.readFileSync('./bot_brain/model.json', 'utf8'));
        const weightData = fs.readFileSync('./bot_brain/weights.bin');
        const arrayBuffer = new Uint8Array(weightData).buffer;

        const botArtifacts = {
            modelTopology: modelJson.modelTopology,
            weightSpecs: modelJson.weightsManifest[0].weights,
            weightData: arrayBuffer,
            format: modelJson.format,
            generatedBy: modelJson.generatedBy,
            convertedBy: modelJson.convertedBy
        };

        botBrain = await tf.loadLayersModel(tf.io.fromMemory(botArtifacts));
        console.log("🤖 Cervello neurale dei Bot caricato con successo!");
    } catch (error) {
        console.log("⚠️ Modello Gioco non trovato. I bot giocheranno a caso nel frattempo.");
    }

    // 2. CARICAMENTO CERVELLO DELL'ASTA (bidBrain)
    try {
        const bidJSON = JSON.parse(fs.readFileSync('./bid_brain/model.json', 'utf8'));
        const bidWeights = fs.readFileSync('./bid_brain/weights.bin');
        const bidWeightData = new Uint8Array(bidWeights).buffer;
        
        const bidArtifacts = {
            modelTopology: bidJSON.modelTopology,
            weightSpecs: bidJSON.weightsManifest[0].weights,
            weightData: bidWeightData,
            format: bidJSON.format,
            generatedBy: bidJSON.generatedBy,
            convertedBy: bidJSON.convertedBy
        };

        bidBrain = await tf.loadLayersModel(tf.io.fromMemory(bidArtifacts));
        console.log("🎩 Cervello dell'Asta (bidBrain) caricato con successo!");
    } catch (err) {
        console.log("⚠️ Nessun bidBrain trovato, i bot faranno aste base.");
    }
}
loadBotModel();

const io = new Server(server, { pingTimeout: 60000, pingInterval: 25000, connectTimeout: 30000 });
const path = require('path');
const PORT = process.env.PORT || 3000;

// --- UTILITY PER LA RETE NEURALE ---
const SUITS = ['denari', 'coppe', 'spade', 'bastoni'];

function getCardIndex(card) {
    if (!card) return -1;
    return SUITS.indexOf(card.suit) * 10 + (card.value - 1);
}

function getStateVector(hand, tableCards, history, calledCard, is29, amICaller, amIPartner, isCallerWinningTrick, pointsOnTable, currentBid, callerPoints, myPoints) {
    const vector = new Array(168).fill(0); 
    hand.forEach(c => vector[getCardIndex(c)] = 1);
    tableCards.forEach(c => vector[40 + getCardIndex(c)] = 1);
    history.forEach(c => vector[80 + getCardIndex(c)] = 1);
    if (calledCard) vector[120 + getCardIndex(calledCard)] = 1;
    if (is29) vector[160] = 1;
    
    // SENSI DI SQUADRA (Senza rivelare il compagno)
    vector[161] = amICaller ? 1 : 0;
    vector[162] = amIPartner ? 1 : 0; // Il bot sa se LUI STESSO è il compagno, ed è giusto
    vector[163] = isCallerWinningTrick ? 1 : 0;
    vector[164] = pointsOnTable / 120; 
    
    // NUOVI SENSI DI PUNTEGGIO (Pubblici)
    vector[165] = currentBid / 120; // Obiettivo dell'asta
    vector[166] = callerPoints / 120; // Punti in cassaforte del Chiamante (pubblico)
    vector[167] = myPoints / 120; // Punti in cassaforte miei
    
    return vector;
}

app.use(express.static(__dirname));
app.use('/carte', express.static(path.join(__dirname, 'carte')));
app.use('/sticker', express.static(path.join(__dirname, 'sticker')));

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

console.log("SERVER AVVIATO: Briscola a 5 (A Chiamata)");

const rooms = {}; 
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
        partnerId: null,
        history: [],
        is29: false,
        currentRound: 1,      // NUOVO
        maxRounds: 1          // NUOVO
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
        room.players.push({ id: botId, name: "Bot_" + room.botCounter++, hand: [], bid: null, tricksWon: 0, tournamentScore: 0, isBot: true, passedBidding: false });
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
        room.players.push({ id: socket.id, name, hand: [], bid: null, tricksWon: 0, tournamentScore: 0, isBot: false, passedBidding: false });
        broadcastUpdate(sanitizedRoom);
    });

    socket.on('startGame', (options) => {
        const roomName = socket.roomName; if (!roomName || !rooms[roomName]) return; const room = rooms[roomName];
        if (room.players[0].id !== socket.id) return;
        if (room.players.length !== 5) return socket.emit('errorMsg', 'Devono esserci esattamente 5 giocatori!');
        
        // Imposta i round e azzera i punteggi del torneo
        room.maxRounds = (options && options.maxRounds) ? options.maxRounds : 1;
        room.currentRound = 1;
        room.players.forEach(p => p.tournamentScore = 0);
        
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

        // LOGICA DEL 29: Se chiama 29, la carta reale cercata è l'Asso (1)
        let actualValue = data.value === 29 ? 1 : data.value;
        let is29 = (data.value === 29); // Rileva se è stato chiamato il 29
        
        room.briscolaSuit = data.suit;
        room.calledCard = { value: actualValue, suit: data.suit };
        room.is29 = is29; // Lo salva nella stanza per l'IA
        
        // Trova il compagno segreto
        room.partnerId = null;
        room.players.forEach(p => {
            if (p.hand.find(c => c.value === actualValue && c.suit === data.suit)) { room.partnerId = p.id; }
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
            let currentBid = room.currentMaxBid || 60; 
            let maxPotential = 61; 
            let plannedCall = null;

            if (bidBrain) {
                let handState = getHandVector(p.hand);
                
                // Il bot "pensa"
                tf.tidy(() => {
                    let preds = bidBrain.predict(tf.tensor2d([handState])).dataSync();
                    let maxPts = -1; let bestIndex = 0;
                    
                    for (let i = 0; i < 40; i++) {
                        if (preds[i] > maxPts) { maxPts = preds[i]; bestIndex = i; }
                    }
                    
                    // Converte la percentuale (0-1) in punti reali (0-120)
                    // Sottrae 2 punti come "margine di sicurezza" per non scommettere tutto
                    maxPotential = Math.floor(maxPts * 120) - 2; 
                    
                    // Salva la mossa geniale da fare se vince l'asta
                    let calledSuit = SUITS[Math.floor(bestIndex / 10)];
                    let calledValue = VALUES[bestIndex % 10];
                    plannedCall = { suit: calledSuit, value: calledValue };
                });
            } else {
                // Se stai ancora addestrando, tira a caso
                maxPotential = 61 + Math.floor(Math.random() * 10);
            }

            // --- LA LOGICA "GAMBLER" (70 -> +2 -> +1) ---
            let nextBid = 0; // 0 significa ritirarsi (Passo)

            if (maxPotential > currentBid) {
                if (currentBid < 70 && maxPotential >= 70) {
                    nextBid = 70; // Salto aggressivo per spaventare
                } else if (maxPotential - currentBid >= 3) {
                    nextBid = currentBid + 2; // Rilancio morbido
                } else {
                    nextBid = currentBid + 1; // Rilancio al limite, braccino corto
                }
            }

            // --- ESECUZIONE DELLA SCELTA ---
            if (nextBid > 0 && nextBid <= 120) {
                // Il bot rilancia!
                room.currentMaxBid = nextBid;
                room.highestBidderId = p.id;
                p.bid = nextBid;
                if (plannedCall) p.plannedCall = plannedCall; // Memorizza chi vuole chiamare
                
                io.to(roomName).emit('statusMsg', `🤖 <b>${p.name}</b> chiama <b>${nextBid}</b>!`);
            } else {
                // Il bot si ritira
                p.passedBidding = true;
                io.to(roomName).emit('statusMsg', `🤖 <b>${p.name}</b> passa.`);
            }

            // Passa il turno dell'asta
            room.currentPlayerIndex = (room.currentPlayerIndex + 1) % 5;
            checkBiddingEnd(roomName); 

        } else if (room.gameState === "CALLING") {
            let chosenSuit;
            let chosenValue;
            let is29 = false;

            // --- PIANO A: L'INTELLIGENZA ARTIFICIALE ---
            // Se il bot ha scommesso usando la Rete Neurale, sa già esattamente cosa voleva chiamare
            if (p.plannedCall) {
                chosenSuit = p.plannedCall.suit;
                chosenValue = p.plannedCall.value;
                
                // Controlla comunque se la chiamata scelta dall'IA rientra nella famosa regola del "29"
                let has1 = p.hand.some(c => c.suit === chosenSuit && c.value === 1);
                let has3 = p.hand.some(c => c.suit === chosenSuit && c.value === 3);
                let has10 = p.hand.some(c => c.suit === chosenSuit && c.value === 10);
                let has9 = p.hand.some(c => c.suit === chosenSuit && c.value === 9);
                let has8 = p.hand.some(c => c.suit === chosenSuit && c.value === 8);
                
                if (!has1 && !has3 && has10 && has9 && has8 && chosenValue === 1) {
                    is29 = true;
                }

            // --- PIANO B: VECCHIA EURISTICA MATEMATICA ---
            // Se la Rete Neurale è spenta o in addestramento, usa la vecchia logica infallibile
            } else {
                let suitCounts = { 'denari': 0, 'coppe': 0, 'spade': 0, 'bastoni': 0 };
                p.hand.forEach(c => suitCounts[c.suit]++);

                // Trova il seme più numeroso
                let maxCount = -1;
                for (let suit in suitCounts) {
                    if (suitCounts[suit] > maxCount) { 
                        maxCount = suitCounts[suit]; 
                        chosenSuit = suit; 
                    }
                }

                // Trova i carichi mancanti in quel seme
                let has1 = p.hand.some(c => c.suit === chosenSuit && c.value === 1);
                let has3 = p.hand.some(c => c.suit === chosenSuit && c.value === 3);
                let has10 = p.hand.some(c => c.suit === chosenSuit && c.value === 10);
                let has9 = p.hand.some(c => c.suit === chosenSuit && c.value === 9);
                let has8 = p.hand.some(c => c.suit === chosenSuit && c.value === 8);

                // Applica la gerarchia
                if (!has1 && !has3 && has10 && has9 && has8) {
                    chosenValue = 1;  
                    is29 = true;      
                } else if (!has1) {
                    chosenValue = 1;
                } else if (!has3) {
                    chosenValue = 3;
                } else if (!has10) {
                    chosenValue = 10;
                } else {
                    chosenValue = 9;
                }
            }

            // --- ESECUZIONE UFFICIALE ---
            // Pulisce la memoria del bot per le prossime mani
            p.plannedCall = null; 
            
            // Invia la decisione al motore di gioco
            handleCall(roomName, p.id, chosenSuit, chosenValue, is29);

        } else if (room.gameState === "PLAYING") {
            
            // 3. RETE NEURALE: Decide la carta da giocare
            let chosenCardIndex = 0;

            if (botBrain) {
               // Recupera le info del tavolo
                let currentTable = room.tableCards ? room.tableCards.map(tc => tc.card) : [];
                let history = room.history || [];
                let is29 = room.is29 || false;

                // --- CALCOLO VARIABILI E PUNTEGGI ONESTI ---
                let amICaller = (p.id === room.highestBidderId);
                let amIPartner = (p.id === room.partnerId);
                
                let caller = room.players.find(pl => pl.id === room.highestBidderId);
                let callerPoints = caller ? caller.tricksWon : 0;
                let myPoints = p.tricksWon;
                let currentBid = room.currentMaxBid || 60;
                
                let isCallerWinningTrick = false;
                let pointsOnTable = 0;
                
                if (room.tableCards.length > 0) {
                    let leadingSuit = room.tableCards[0].card.suit;
                    let winnerCard = room.tableCards[0];
                    let maxP = getCardPowerBriscola(winnerCard.card, leadingSuit, room.briscolaSuit);
                    pointsOnTable += BRISCOLA_POINTS[winnerCard.card.value] || 0;

                    for (let i = 1; i < room.tableCards.length; i++) {
                        let tc = room.tableCards[i];
                        pointsOnTable += BRISCOLA_POINTS[tc.card.value] || 0;
                        let pwr = getCardPowerBriscola(tc.card, leadingSuit, room.briscolaSuit);
                        if (pwr > maxP) { maxP = pwr; winnerCard = tc; }
                    }
                    if (winnerCard.playerId === room.highestBidderId) {
                        isCallerWinningTrick = true;
                    }
                }
                // -----------------------------------------------

                // Genera la "Vista" e interroga il cervello
                let state = getStateVector(p.hand, currentTable, history, room.calledCard, is29, amICaller, amIPartner, isCallerWinningTrick, pointsOnTable, currentBid, callerPoints, myPoints);
                
                let qValues = tf.tidy(() => {
                    const stateTensor = tf.tensor2d([state]);
                    return botBrain.predict(stateTensor).dataSync();
                });

                // Cerca la carta fisicamente in mano con il voto più alto
                let maxQ = -Infinity;
                p.hand.forEach((card, idx) => {
                    let globalIdx = getCardIndex(card);
                    if (qValues[globalIdx] > maxQ) {
                        maxQ = qValues[globalIdx];
                        chosenCardIndex = idx;
                    }
                });
            } else {
                chosenCardIndex = Math.floor(Math.random() * p.hand.length);
            }

            // Gioca la carta scelta
            const playedCard = p.hand.splice(chosenCardIndex, 1)[0];
            
            // AGGIORNATO AL METODO CORRETTO
            room.tableCards.push({ playerId: p.id, card: playedCard, playerName: p.name }); 
            io.to(roomName).emit('tableUpdate', room.tableCards); 
            
            room.currentPlayerIndex = (room.currentPlayerIndex + 1) % 5;
            broadcastUpdate(roomName);
            
            // CONTROLLO CORRETTO DI FINE PASSATA
            if (room.tableCards.length === 5) {
                evaluateTrick(roomName);
            } else {
                updateGameState(roomName);
            }
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
                list: room.players.map((pl, idx) => ({ id: pl.id, name: pl.name, isBot: pl.isBot, tricksWon: pl.tricksWon, tournamentScore: pl.tournamentScore, passedBidding: pl.passedBidding, bid: pl.bid, isDealer: (idx === room.dealerIndex), handCount: pl.hand.length })),
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
  room.history = []; 
  room.is29 = false;
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
        
        // --- SALVA LE CARTE NELLA MEMORIA PRIMA DI PULIRE IL TAVOLO ---
        r.tableCards.forEach(tc => r.history.push(tc.card));
        // --------------------------------------------------------------

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
    let isCappotto = (pointsAttacking === 120 || pointsAttacking === 0);
    let isSolitario = (!partner || partner.id === caller.id);
    
    // --- STRADA 1: PARTITA SINGOLA ---
    if (room.maxRounds === 1) {
        let reportMsg = `📊 <b>FINE PARTITA</b> 📊<br><br>`;
        reportMsg += `Chiamante: <b>${caller.name}</b> (Obiettivo: ${room.currentMaxBid})<br>`;
        if (!isSolitario) reportMsg += `Compagno: <b>${partner.name}</b><br>`;
        else reportMsg += `<i>Il Chiamante ha giocato da solo!</i><br>`;
        reportMsg += `Punti Fatti: <b>${pointsAttacking}</b>/120 ${isCappotto ? ' (CAPPOTTO! 🧥)' : ''}<br><br>`;
        
        if (win) reportMsg += `<span style='color:#00ff00; font-size:18px;'>🎉 I CHIAMANTI VINCONO! 🎉</span>`;
        else reportMsg += `<span style='color:#ff4444; font-size:18px;'>🛡️ I DIFENSORI VINCONO! 🛡️</span>`;

        io.to(roomName).emit('statusMsg', reportMsg);
        
        // Aspetta 8 secondi e torna in Lobby
        setTimeout(() => {
            if(rooms[roomName]) {
                room.dealerIndex = (room.dealerIndex + 1) % 5;
                resetGame(roomName); 
            }
        }, 8000);

    // --- STRADA 2: TORNEO A PUNTI ---
    } else {
        // Calcolo punteggi
        let bid = room.currentMaxBid;
        let ptsChiamante = 2, ptsCompagno = 1, ptsAvversari = 1;

        if (bid >= 60 && bid <= 79) { ptsChiamante = 2; ptsCompagno = 1; ptsAvversari = 1; }
        else if (bid >= 80 && bid <= 89) { ptsChiamante = 4; ptsCompagno = 2; ptsAvversari = 2; }
        else if (bid >= 90 && bid <= 99) { ptsChiamante = 6; ptsCompagno = 3; ptsAvversari = 3; }
        else if (bid >= 100 && bid <= 109) { ptsChiamante = 8; ptsCompagno = 4; ptsAvversari = 4; }
        else if (bid >= 110 && bid <= 120) { ptsChiamante = 12; ptsCompagno = 6; ptsAvversari = 6; }

        if (isCappotto) { ptsChiamante *= 2; ptsCompagno *= 2; ptsAvversari *= 2; }

        room.players.forEach(p => {
            if (p.id === caller.id) {
                let pts = isSolitario ? (ptsChiamante + ptsCompagno) : ptsChiamante;
                p.tournamentScore += win ? pts : -pts;
            } else if (!isSolitario && partner && p.id === partner.id) {
                p.tournamentScore += win ? ptsCompagno : -ptsCompagno;
            } else {
                p.tournamentScore += win ? -ptsAvversari : ptsAvversari;
            }
        });

        let reportMsg = `📊 <b>FINE ROUND ${room.currentRound} / ${room.maxRounds}</b> 📊<br><br>`;
        reportMsg += `Chiamante: <b>${caller.name}</b> (Obiettivo: ${room.currentMaxBid})<br>`;
        if (!isSolitario) reportMsg += `Compagno: <b>${partner.name}</b><br>`;
        else reportMsg += `<i>Il Chiamante ha giocato da solo!</i><br>`;
        reportMsg += `Punti Fatti: <b>${pointsAttacking}</b>/120 ${isCappotto ? ' (CAPPOTTO! 🧥)' : ''}<br><br>`;
        
        if (win) reportMsg += `<span style='color:#00ff00; font-size:18px;'>🎉 I CHIAMANTI VINCONO! 🎉</span>`;
        else reportMsg += `<span style='color:#ff4444; font-size:18px;'>🛡️ I DIFENSORI VINCONO! 🛡️</span>`;

        // Logica Turni Torneo
        if (room.currentRound < room.maxRounds) {
            room.currentRound++;
            reportMsg += `<br><br>⏳ <i>Prossima partita tra 8 secondi...</i>`;
            io.to(roomName).emit('statusMsg', reportMsg);
            broadcastUpdate(roomName); 
            
            // Nuova Partita
            setTimeout(() => {
                if(rooms[roomName]) {
                    room.dealerIndex = (room.dealerIndex + 1) % 5;
                    startRound(roomName);
                }
            }, 8000);
        } else {
            reportMsg += `<br><br>🏆 <b>TORNEO CONCLUSO!</b> 🏆<br><br><b>Classifica Finale:</b><br>`;
            let sorted = [...room.players].sort((a,b) => b.tournamentScore - a.tournamentScore);
            sorted.forEach((p, i) => {
                reportMsg += `${i+1}. ${p.name}: <b>${p.tournamentScore} pt</b><br>`;
            });
            
            io.to(roomName).emit('statusMsg', reportMsg);
            broadcastUpdate(roomName);
            
            // Ritorno in Lobby post Torneo
            setTimeout(() => {
                if(rooms[roomName]) {
                    room.dealerIndex = (room.dealerIndex + 1) % 5;
                    resetGame(roomName); 
                }
            }, 12000); 
        }
    }
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