/**
 * 拖拉机 - UI交互与游戏流程控制
 */

// 游戏状态实例
let game = new GameState();
let selectedCards = [];
let isHumanTurn = false;
let currentBid = null;
let bidPlayer = null;

// DOM元素引用
const elements = {};

function initElements() {
    elements.handArea = document.getElementById('hand-area');
    elements.playArea = document.getElementById('play-area');
    elements.playSlots = {
        left: document.getElementById('play-left'),
        top: document.getElementById('play-top'),
        right: document.getElementById('play-right'),
        bottom: document.getElementById('play-bottom')
    };
    elements.actionButtons = document.getElementById('action-buttons');
    elements.bidModal = document.getElementById('bid-modal');
    elements.bidOptions = document.getElementById('bid-options');
    elements.passBid = document.getElementById('pass-bid');
    elements.buryModal = document.getElementById('bury-modal');
    elements.buryArea = document.getElementById('bury-area');
    elements.burySelected = document.getElementById('bury-selected');
    elements.confirmBury = document.getElementById('confirm-bury');
    elements.gameoverModal = document.getElementById('gameover-modal');
    elements.gameoverTitle = document.getElementById('gameover-title');
    elements.gameoverResult = document.getElementById('gameover-result');
    elements.nextGame = document.getElementById('next-game');
    elements.startScreen = document.getElementById('start-screen');
    elements.startGame = document.getElementById('start-game');
    elements.logContent = document.getElementById('log-content');
    
    // 信息栏
    elements.currentLevel = document.getElementById('current-level');
    elements.trumpSuit = document.getElementById('trump-suit');
    elements.currentDealer = document.getElementById('current-dealer');
    elements.scoreInfo = document.getElementById('score-info');
    elements.teamA = document.getElementById('team-a');
    elements.teamB = document.getElementById('team-b');
    elements.humanRole = document.getElementById('human-role');
    
    // 玩家牌数
    elements.cardCounts = {
        left: document.getElementById('left-card-count'),
        top: document.getElementById('top-card-count'),
        right: document.getElementById('right-card-count')
    };
    
    // 玩家位置
    elements.playerPositions = {
        left: document.getElementById('player-left'),
        top: document.getElementById('player-top'),
        right: document.getElementById('player-right')
    };
}

// 日志
function log(message) {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.textContent = `${new Date().toLocaleTimeString()} ${message}`;
    elements.logContent.appendChild(entry);
    elements.logContent.scrollTop = elements.logContent.scrollHeight;
}

// 更新信息栏
function updateInfo() {
    elements.currentLevel.textContent = `当前打: ${game.level}`;
    elements.trumpSuit.textContent = `主花色: ${game.trumpSuit ? SUIT_SYMBOLS[game.trumpSuit] : '无'}`;
    
    const dealerNames = {
        bottom: '你',
        left: 'AI-左',
        top: 'AI-上',
        right: 'AI-右'
    };
    elements.currentDealer.textContent = `庄家: ${game.dealer ? dealerNames[game.dealer] : '--'}`;
    elements.scoreInfo.textContent = `得分: ${game.trickScores.teamA} / 200`;
    
    elements.teamA.textContent = `我方: ${game.teamLevels.teamA}`;
    elements.teamB.textContent = `对方: ${game.teamLevels.teamB}`;
    
    const isDealer = game.dealer === 'bottom';
    elements.humanRole.textContent = game.dealer === null ? '待定' : (isDealer ? '庄家' : '闲家');
    
    // 更新AI牌数
    for (const pos of ['left', 'top', 'right']) {
        elements.cardCounts[pos].textContent = `${game.players[pos].length}张`;
    }
}

// 创建牌的DOM元素
function createCardElement(card, selectable = false, onClick = null) {
    const display = getCardDisplay(card);
    const isTrump = game.trumpSuit && isTrumpCard(card, game.trumpSuit, game.level);
    
    const cardEl = document.createElement('div');
    cardEl.className = `card ${display.color} ${isTrump ? 'trump' : ''} ${selectable ? '' : 'disabled'}`;
    cardEl.dataset.cardId = card.id;
    
    if (card.isJoker) {
        cardEl.innerHTML = `
            <div class="card-top-left">
                <span class="card-rank">${display.rank}</span>
            </div>
            <div class="card-center">${display.suit}</div>
            <div class="card-bottom-right">
                <span class="card-rank">${display.rank}</span>
            </div>
        `;
    } else {
        cardEl.innerHTML = `
            <div class="card-top-left">
                <span class="card-rank">${display.rank}</span>
                <span class="card-suit">${display.suit}</span>
            </div>
            <div class="card-center">${display.suit}</div>
            <div class="card-bottom-right">
                <span class="card-rank">${display.rank}</span>
                <span class="card-suit">${display.suit}</span>
            </div>
        `;
    }
    
    if (selectable && onClick) {
        cardEl.addEventListener('click', () => onClick(card, cardEl));
    }
    
    return cardEl;
}

// 渲染玩家手牌
function renderHand() {
    elements.handArea.innerHTML = '';
    const hand = game.players.bottom;
    
    for (let i = 0; i < hand.length; i++) {
        const card = hand[i];
        const cardEl = createCardElement(card, isHumanTurn, onCardClick);
        
        // 检查是否已选中
        if (selectedCards.some(c => c.id === card.id)) {
            cardEl.classList.add('selected');
        }
        
        elements.handArea.appendChild(cardEl);
    }
}

// 牌点击事件
function onCardClick(card, cardEl) {
    if (!isHumanTurn) return;
    
    const idx = selectedCards.findIndex(c => c.id === card.id);
    if (idx !== -1) {
        selectedCards.splice(idx, 1);
        cardEl.classList.remove('selected');
    } else {
        selectedCards.push(card);
        cardEl.classList.add('selected');
    }
    
    updateActionButtons();
}

// 更新操作按钮
function updateActionButtons() {
    elements.actionButtons.innerHTML = '';
    
    if (game.phase === 'playing' && isHumanTurn) {
        const playBtn = document.createElement('button');
        playBtn.className = 'btn btn-primary';
        playBtn.textContent = '出牌';
        playBtn.disabled = selectedCards.length === 0;
        playBtn.onclick = onHumanPlay;
        elements.actionButtons.appendChild(playBtn);
        
        const clearBtn = document.createElement('button');
        clearBtn.className = 'btn btn-secondary';
        clearBtn.textContent = '清除选择';
        clearBtn.onclick = () => {
            selectedCards = [];
            renderHand();
            updateActionButtons();
        };
        elements.actionButtons.appendChild(clearBtn);
    }
}

// 渲染出牌区域
function renderPlayArea() {
    for (const pos of PLAYERS) {
        elements.playSlots[pos].innerHTML = '';
    }
    
    for (const play of game.currentTrick) {
        const slot = elements.playSlots[play.player];
        for (const card of play.cards) {
            const cardEl = createCardElement(card, false);
            cardEl.classList.add('card-playing');
            slot.appendChild(cardEl);
        }
    }
}

// 高亮当前玩家
function highlightCurrentPlayer(position) {
    for (const pos of ['left', 'top', 'right']) {
        elements.playerPositions[pos].classList.remove('current-turn');
    }
    
    if (position !== 'bottom') {
        elements.playerPositions[position].classList.add('current-turn');
    }
}

// 显示本轮赢家
function showTrickWinner(winner) {
    const winnerEl = document.getElementById('trick-winner');
    const names = {
        bottom: '你',
        left: 'AI-左',
        top: 'AI-上',
        right: 'AI-右'
    };
    winnerEl.textContent = `${names[winner]} 赢`;
    winnerEl.classList.add('show');
    
    setTimeout(() => {
        winnerEl.classList.remove('show');
    }, 1500);
}

// ===== 游戏流程控制 =====

// 开始游戏
function startGame() {
    elements.startScreen.classList.add('hidden');
    game.reset();
    
    // 重置AI
    for (const ai of Object.values(aiPlayers)) {
        ai.reset();
    }
    
    log('======== 新游戏开始 ========');
    startRound();
}

// 开始一轮
function startRound() {
    // 区分新游戏和后续轮次
    const isFirstRound = (game.dealer === null);
    
    if (isFirstRound) {
        // 全新游戏：完全重置
        game.reset();
        for (const ai of Object.values(aiPlayers)) {
            ai.reset();
        }
        log('======== 新游戏开始 ========');
    } else {
        // 后续轮次：保留庄家和级别，重置局内状态
        game.prepareNextRound();
        for (const ai of Object.values(aiPlayers)) {
            ai.reset();
        }
    }
    
    game.phase = 'dealing';
    selectedCards = [];
    currentBid = null;
    bidPlayer = null;
    
    log(`开始发牌，当前打 ${game.level}${isFirstRound ? '（首轮抢庄）' : `，庄家: ${game.dealer === 'bottom' ? '你' : game.dealer === 'left' ? 'AI-左' : game.dealer === 'top' ? 'AI-上' : 'AI-右'}`}`);
    updateInfo();
    elements.handArea.innerHTML = '';
    renderPlayArea();
    document.getElementById('deck-count').textContent = '0';
    
    // 开始逐张发牌
    startAnimatedDealing();
}

// ===== 发牌与叫主状态 =====
let dealTimer = null;
let bidCountdownTimer = null;

// 逐张发牌
function startAnimatedDealing() {
    game.startDealing();
    dealNextCardAnimated();
}

function dealNextCardAnimated() {
    if (game.isDealingComplete()) {
        afterDealingComplete();
        return;
    }
    
    const result = game.dealNextCard();
    if (!result) {
        afterDealingComplete();
        return;
    }
    
    if (result.isKitty) {
        // 底牌
        document.getElementById('deck-count').textContent = game.kitty.length;
    } else {
        updateInfo();
        
        // 更新该玩家的手牌排序
        if (game.trumpSuit !== null) {
            game.sortHand(result.player);
        }
        
        if (result.player === 'bottom') {
            // 重新渲染手牌
            renderHand();
            // 最后一张牌加发牌动画
            const cards = elements.handArea.querySelectorAll('.card');
            if (cards.length > 0) {
                cards[cards.length - 1].classList.add('card-dealing');
            }
        }
        
        // === 叫主/反主检查 ===
        const hand = game.players[result.player];
        const availableBids = getAvailableBids(hand, game.level, game.bidState.currentBid);
        
        if (availableBids.length > 0) {
            if (result.player === 'bottom') {
                // 玩家：暂停5秒，显示叫主/反主弹窗
                // 先清除可能存在的发牌计时器，确保弹窗期间不再发牌
                if (dealTimer) { clearTimeout(dealTimer); dealTimer = null; }
                showBidPauseNotice(availableBids);
                return;
            } else {
                // AI：自动决定是否叫主/反主（不暂停动画）
                const ai = aiPlayers[result.player];
                const bidDecision = ai.decideBidWithCounter(
                    hand, game.level, game.bidState.currentBid
                );
                if (bidDecision) {
                    handleAiBid(result.player, bidDecision);
                    
                    // AI叫主后，检查玩家是否能反主，如能则暂停5秒
                    const playerHand = game.players.bottom;
                    const playerCounterBids = getAvailableBids(playerHand, game.level, game.bidState.currentBid);
                    if (playerCounterBids.length > 0) {
                        // 先清除可能存在的发牌计时器
                        if (dealTimer) { clearTimeout(dealTimer); dealTimer = null; }
                        showBidPauseNotice(playerCounterBids);
                        return;
                    }
                }
            }
        }
    }
    
    // 0.3秒后发下一张
    dealTimer = setTimeout(() => dealNextCardAnimated(), 300);
}

/**
 * 处理AI叫主/反主
 */
function handleAiBid(player, bidDecision) {
    const suitName = {
        [SUITS.SPADES]: '黑桃',
        [SUITS.HEARTS]: '红桃',
        [SUITS.CLUBS]: '梅花',
        [SUITS.DIAMONDS]: '方片'
    };
    const names = { left: 'AI-左', top: 'AI-上', right: 'AI-右' };
    
    const success = game.makeBid(player, bidDecision);
    if (!success) return;
    
    currentBid = game.bidState.currentBid;
    bidPlayer = player;
    
    const bidTypeNames = {
        [BID_TYPES.SINGLE]: '叫主',
        [BID_TYPES.PAIR_LEVEL]: '反主',
        [BID_TYPES.PAIR_SMALL_JOKER]: '反主',
        [BID_TYPES.PAIR_BIG_JOKER]: '反主'
    };
    
    const trumpDisplay = bidDecision.suit ? SUIT_SYMBOLS[bidDecision.suit] : '无主';
    log(`${names[player]} ${bidTypeNames[bidDecision.type]} ${bidDecision.display} → 主: ${trumpDisplay}`);
    
    // 首轮第一次叫主确定庄家，通知玩家
    if (game.bidState.bidHistory.length === 1) {
        log(`🏦 ${names[player]} 成为庄家`);
    }
    
    updateInfo();
    // 重新排序并渲染所有手牌
    for (const pos of PLAYERS) {
        game.sortHand(pos);
    }
    renderHand();
}

// 叫主暂停提示（5秒倒计时）—— 适配新叫主系统
function showBidPauseNotice(availableBids) {
    const names = { left: 'AI-左', top: 'AI-上', right: 'AI-右' };
    
    const notice = document.createElement('div');
    notice.className = 'bid-pause-notice';
    notice.id = 'bid-pause-notice';
    
    // 读取当前叫主状态（使用全局变量，不新建局部const）
    const cb = game.bidState.currentBid;
    const isCounter = !!cb; // 是否是反主
    const title = isCounter ? '反主时间' : '叫主时间';
    
    let currentBidInfo = '';
    if (isCounter) {
        const bidderName = cb.player === 'bottom' ? '你' : (names[cb.player] || cb.player);
        const trumpDisplay = cb.suit ? SUIT_SYMBOLS[cb.suit] : '无主';
        currentBidInfo = `<div class="notice-card-info">当前: ${bidderName} ${cb.display || ''} → ${trumpDisplay}</div>`;
    }
    
    // 构建叫主/反主按钮
    let bidButtonsHTML = '';
    for (const bid of availableBids) {
        const isRed = bid.suit === SUITS.HEARTS || bid.suit === SUITS.DIAMONDS;
        let colorClass = '';
        if (bid.type === BID_TYPES.PAIR_SMALL_JOKER) colorClass = 'gray';
        else if (bid.type === BID_TYPES.PAIR_BIG_JOKER || isRed) colorClass = 'red';
        else colorClass = 'black';
        
        bidButtonsHTML += `
            <button class="bid-flip-btn ${colorClass}" data-bid-idx="${availableBids.indexOf(bid)}">
                ${bid.display}
                <span class="flip-desc">${isCounter ? '反主' : '叫主'}</span>
            </button>
        `;
    }
    
    notice.innerHTML = `
        <div class="notice-title">${title}</div>
        ${currentBidInfo}
        <div class="notice-countdown" id="bid-countdown">5</div>
        <div class="notice-hint">点击${isCounter ? '反主' : '叫主'}，或等待5秒后自动跳过</div>
        ${bidButtonsHTML ? `<div class="bid-section-title">${isCounter ? '可反主选项' : '可叫主选项'}</div><div class="bid-buttons" id="bid-flip-buttons">${bidButtonsHTML}</div>` : '<div class="bid-section-title" style="color: rgba(255,255,255,0.5)">无可用选项</div>'}
        <button class="bid-pass-btn" id="bid-pass-btn">不${isCounter ? '反' : '叫'}</button>
    `;
    
    document.body.appendChild(notice);
    log(isCounter ? `你可以反主，5秒内选择` : `你可以叫主，5秒内选择`);
    
    // 5秒倒计时
    let countdown = 5;
    const countdownEl = document.getElementById('bid-countdown');
    const countdownTimer = setInterval(() => {
        countdown--;
        if (countdownEl) countdownEl.textContent = countdown;
        if (countdown <= 0) {
            clearInterval(countdownTimer);
            closeBidPauseNotice(false);
        }
    }, 1000);
    
    // 叫主/反主按钮
    notice.querySelectorAll('.bid-flip-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[叫主] 按钮点击，bidIdx=', btn.dataset.bidIdx);
            
            const bidIdx = parseInt(btn.dataset.bidIdx);
            const bid = availableBids[bidIdx];
            if (!bid) {
                console.error('[叫主] 找不到叫主选项，idx=', bidIdx);
                return;
            }
            
            const success = game.makeBid('bottom', bid);
            console.log('[叫主] makeBid结果:', success, 'bid=', bid.display);
            if (!success) {
                console.warn('[叫主] makeBid失败，当前currentBid=', game.bidState.currentBid);
                return;
            }
            
            // 更新全局变量（而非局部const）
            currentBid = game.bidState.currentBid;
            bidPlayer = 'bottom';
            
            const trumpDisplay = bid.suit ? SUIT_SYMBOLS[bid.suit] : '无主';
            const bidTypeNames = {
                [BID_TYPES.SINGLE]: '叫主',
                [BID_TYPES.PAIR_LEVEL]: '反主',
                [BID_TYPES.PAIR_SMALL_JOKER]: '反主',
                [BID_TYPES.PAIR_BIG_JOKER]: '反主'
            };
            log(`✅ 你 ${bidTypeNames[bid.type]} ${bid.display} → 主: ${trumpDisplay}`);
            
            if (game.dealer === 'bottom' && !game.bidState.dealerConfirmed) {
                log(`🏦 你 成为庄家`);
            }
            
            updateInfo();
            for (const pos of PLAYERS) {
                game.sortHand(pos);
            }
            renderHand();
            clearInterval(countdownTimer);
            closeBidPauseNotice(true);
        });
    });
    
    // 不叫按钮
    const passBtn = document.getElementById('bid-pass-btn');
    if (passBtn) {
        passBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[叫主] 不叫按钮点击');
            clearInterval(countdownTimer);
            closeBidPauseNotice(false);
        });
    }
}

function closeBidPauseNotice(bidCalled) {
    const notice = document.getElementById('bid-pause-notice');
    if (notice) notice.remove();
    
    if (!bidCalled) {
        log('未叫主，继续发牌');
    }
    
    // 继续发牌
    dealTimer = setTimeout(() => dealNextCardAnimated(), 300);
}

// 发牌完成后
function afterDealingComplete() {
    // 排序所有手牌
    for (const pos of PLAYERS) {
        game.sortHand(pos);
    }
    renderHand();
    updateInfo();
    log('发牌完成');
    
    if (game.bidState.currentBid) {
        // 发牌中已有人叫主，给玩家5秒最终反主机会
        finalCounterBidPhase();
    } else {
        // 无人叫主，AI快速叫主
        finalAiBidPhase();
    }
}

/**
 * 发牌完毕后的最终反主阶段
 * 玩家有5秒反主机会，同时AI也检查是否能反主
 */
function finalCounterBidPhase() {
    const names = { left: 'AI-左', top: 'AI-上', right: 'AI-右' };
    // 读取当前叫主状态（不新建局部const，避免遮蔽全局变量）
    const cb = game.bidState.currentBid;
    
    // 先检查AI是否能反主
    const aiOrder = ['left', 'top', 'right'];
    for (const player of aiOrder) {
        const ai = aiPlayers[player];
        const hand = game.players[player];
        const bidDecision = ai.decideBidWithCounter(hand, game.level, cb);
        if (bidDecision) {
            const success = game.makeBid(player, bidDecision);
            if (success) {
                const trumpDisplay = bidDecision.suit ? SUIT_SYMBOLS[bidDecision.suit] : '无主';
                log(`✅ ${names[player]} 反主 ${bidDecision.display} → 主: ${trumpDisplay}`);
                updateInfo();
                for (const pos of PLAYERS) {
                    game.sortHand(pos);
                }
                renderHand();
            }
        }
    }
    
    // 检查玩家是否能反主
    const playerHand = game.players.bottom;
    const availableBids = getAvailableBids(playerHand, game.level, game.bidState.currentBid);
    
    if (availableBids.length > 0) {
        // 玩家可以反主，给5秒
        log('你最终反主机会（5秒）');
        showFinalCounterNotice(availableBids);
    } else {
        // 玩家无法反主，直接进入埋底
        const trumpDisplay = game.trumpSuit ? SUIT_SYMBOLS[game.trumpSuit] : '无主';
        log(`主花色确定: ${trumpDisplay}`);
        setTimeout(() => startBurying(), 800);
    }
}

/**
 * 显示最终反主弹窗
 */
function showFinalCounterNotice(availableBids) {
    const names = { left: 'AI-左', top: 'AI-上', right: 'AI-右' };
    
    const notice = document.createElement('div');
    notice.className = 'bid-pause-notice';
    notice.id = 'bid-pause-notice';
    
    // 读取当前叫主状态（使用局部别名，不遮蔽全局 currentBid）
    const cb = game.bidState.currentBid;
    const bidderName = cb.player === 'bottom' ? '你' : (names[cb.player] || cb.player);
    const trumpDisplay = cb.suit ? SUIT_SYMBOLS[cb.suit] : '无主';
    
    let bidButtonsHTML = '';
    for (const bid of availableBids) {
        const isRed = bid.suit === SUITS.HEARTS || bid.suit === SUITS.DIAMONDS;
        let colorClass = '';
        if (bid.type === BID_TYPES.PAIR_SMALL_JOKER) colorClass = 'gray';
        else if (bid.type === BID_TYPES.PAIR_BIG_JOKER || isRed) colorClass = 'red';
        else colorClass = 'black';
        
        bidButtonsHTML += `
            <button class="bid-flip-btn ${colorClass}" data-bid-idx="${availableBids.indexOf(bid)}">
                ${bid.display}
                <span class="flip-desc">反主</span>
            </button>
        `;
    }
    
    notice.innerHTML = `
        <div class="notice-title">最终反主机会</div>
        <div class="notice-card-info">当前: ${bidderName} ${cb.display || ''} → ${trumpDisplay}</div>
        <div class="notice-countdown" id="bid-countdown">5</div>
        <div class="notice-hint">点击反主，或等待5秒后确认</div>
        <div class="bid-section-title">可反主选项</div>
        <div class="bid-buttons" id="bid-flip-buttons">${bidButtonsHTML}</div>
        <button class="bid-pass-btn" id="bid-pass-btn">不反主</button>
    `;
    
    document.body.appendChild(notice);
    
    let countdown = 5;
    const countdownEl = document.getElementById('bid-countdown');
    const countdownTimer = setInterval(() => {
        countdown--;
        if (countdownEl) countdownEl.textContent = countdown;
        if (countdown <= 0) {
            clearInterval(countdownTimer);
            confirmFinalBid();
        }
    }, 1000);
    
    notice.querySelectorAll('.bid-flip-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[最终反主] 按钮点击，bidIdx=', btn.dataset.bidIdx);
            
            const bidIdx = parseInt(btn.dataset.bidIdx);
            const bid = availableBids[bidIdx];
            if (!bid) {
                console.error('[最终反主] 找不到反主选项，idx=', bidIdx);
                return;
            }
            
            const success = game.makeBid('bottom', bid);
            console.log('[最终反主] makeBid结果:', success, 'bid=', bid.display);
            if (!success) {
                console.warn('[最终反主] makeBid失败，当前currentBid=', game.bidState.currentBid);
                return;
            }
            
            const trumpDisplay = bid.suit ? SUIT_SYMBOLS[bid.suit] : '无主';
            log(`✅ 你 反主 ${bid.display} → 主: ${trumpDisplay}`);
            
            updateInfo();
            for (const pos of PLAYERS) {
                game.sortHand(pos);
            }
            renderHand();
            clearInterval(countdownTimer);
            confirmFinalBid();
        });
    });
    
    const passBtn2 = document.getElementById('bid-pass-btn');
    if (passBtn2) {
        passBtn2.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[最终反主] 不反主按钮点击');
            clearInterval(countdownTimer);
            confirmFinalBid();
        });
    }
}

/**
 * 确认最终叫主，进入埋底
 */
function confirmFinalBid() {
    const notice = document.getElementById('bid-pause-notice');
    if (notice) notice.remove();
    
    const trumpDisplay = game.trumpSuit ? SUIT_SYMBOLS[game.trumpSuit] : '无主';
    log(`主花色确定: ${trumpDisplay}`);
    setTimeout(() => startBurying(), 800);
}

/**
 * 发牌完毕后无人叫主，AI快速叫主
 */
function finalAiBidPhase() {
    const order = ['left', 'top', 'right', 'bottom'];
    const names = { left: 'AI-左', top: 'AI-上', right: 'AI-右', bottom: '你' };
    const suitName = {
        [SUITS.SPADES]: '黑桃',
        [SUITS.HEARTS]: '红桃',
        [SUITS.CLUBS]: '梅花',
        [SUITS.DIAMONDS]: '方片'
    };
    
    // AI先尝试叫主
    for (const player of ['left', 'top', 'right']) {
        const ai = aiPlayers[player];
        const bidDecision = ai.decideBidWithCounter(game.players[player], game.level, null);
        if (bidDecision) {
            const success = game.makeBid(player, bidDecision);
            if (success) {
                const trumpDisplay = bidDecision.suit ? SUIT_SYMBOLS[bidDecision.suit] : '无主';
                log(`✅ ${names[player]} 叫主 ${bidDecision.display} → 主: ${trumpDisplay}`);
                updateInfo();
                for (const pos of PLAYERS) {
                    game.sortHand(pos);
                }
                renderHand();
                setTimeout(() => startBurying(), 1000);
                return;
            }
        }
    }
    
    // 检查玩家是否能叫主
    const playerHand = game.players.bottom;
    const availableBids = getAvailableBids(playerHand, game.level, null);
    if (availableBids.length > 0) {
        log('无人叫主，你的叫主机会（5秒）');
        showFinalCounterNotice(availableBids);
        return;
    }
    
    // 无人叫主，重新发牌
    log('无人叫主，重新发牌');
    setTimeout(() => startRound(), 1500);
}

// 埋底阶段
function startBurying() {
    game.phase = 'burying';
    log('开始埋底...');
    
    if (game.dealer === 'bottom') {
        // 玩家埋底
        showBuryModal();
    } else {
        // AI埋底
        setTimeout(() => {
            const ai = aiPlayers[game.dealer];
            const hand = [...game.players[game.dealer], ...game.kitty];
            const toBury = ai.decideBury(hand, game.trumpSuit, game.level);
            
            game.buryCards(toBury);
            log(`${game.dealer === 'left' ? 'AI-左' : game.dealer === 'top' ? 'AI-上' : 'AI-右'} 完成埋底`);
            
            setTimeout(() => startPlaying(), 500);
        }, 800);
    }
}

// 显示埋底弹窗
function showBuryModal() {
    elements.buryArea.innerHTML = '';
    elements.buryModal.classList.add('show');
    
    const hand = [...game.players.bottom, ...game.kitty];
    let selectedBury = [];
    
    // 按花色分组排序
    const suitOrder = {
        [SUITS.SPADES]: 0,
        [SUITS.HEARTS]: 1,
        [SUITS.CLUBS]: 2,
        [SUITS.DIAMONDS]: 3
    };
    hand.sort((a, b) => {
        const aTrump = isTrump(a, game.trumpSuit, game.level);
        const bTrump = isTrump(b, game.trumpSuit, game.level);
        const aGroup = aTrump ? 4 : (suitOrder[a.suit] !== undefined ? suitOrder[a.suit] : 5);
        const bGroup = bTrump ? 4 : (suitOrder[b.suit] !== undefined ? suitOrder[b.suit] : 5);
        if (aGroup !== bGroup) return aGroup - bGroup;
        return getCardValue(a, game.trumpSuit, game.level) - getCardValue(b, game.trumpSuit, game.level);
    });
    
    for (const card of hand) {
        const cardEl = createCardElement(card, true, (c, el) => {
            const idx = selectedBury.findIndex(sc => sc.id === c.id);
            if (idx !== -1) {
                selectedBury.splice(idx, 1);
                el.classList.remove('selected');
            } else if (selectedBury.length < 8) {
                selectedBury.push(c);
                el.classList.add('selected');
            }
            
            elements.burySelected.textContent = `已选: ${selectedBury.length}/8`;
            elements.confirmBury.disabled = selectedBury.length !== 8;
        });
        
        elements.buryArea.appendChild(cardEl);
    }
    
    elements.burySelected.textContent = '已选: 0/8';
    elements.confirmBury.disabled = true;
    
    elements.confirmBury.onclick = () => {
        game.buryCards(selectedBury);
        log('你完成埋底');
        elements.buryModal.classList.remove('show');
        updateInfo();
        renderHand();
        setTimeout(() => startPlaying(), 500);
    };
}

// 出牌阶段
function startPlaying() {
    game.phase = 'playing';
    log('开始出牌！');
    
    // 从庄家开始
    const playOrder = getPlayOrder();
    processPlay(playOrder, 0);
}

// 获取出牌顺序
function getPlayOrder() {
    const idx = PLAYERS.indexOf(game.dealer);
    return [...PLAYERS.slice(idx), ...PLAYERS.slice(0, idx)];
}

// 处理出牌
function processPlay(order, index) {
    // 检查是否一局结束
    if (game.players.bottom.length === 0) {
        endRound();
        return;
    }
    
    const player = order[index % 4];
    const names = { bottom: '你', left: 'AI-左', top: 'AI-上', right: 'AI-右' };
    
    if (player === 'bottom') {
        // 玩家出牌
        isHumanTurn = true;
        selectedCards = [];
        highlightCurrentPlayer('bottom');
        renderHand();
        updateActionButtons();
        
        log('请出牌...');
    } else {
        // AI出牌
        isHumanTurn = false;
        highlightCurrentPlayer(player);
        renderHand();
        updateActionButtons();
        
        setTimeout(() => {
            const ai = aiPlayers[player];
            const cards = ai.decidePlay(game.players[player], game, game.currentTrick);
            
            // 验证出牌
            if (!isValidPlay(game.players[player], cards, game.currentTrick, game.trumpSuit, game.level)) {
                // AI出错了，强制出合法的牌
                const forcedCards = forceValidPlay(game.players[player], game.currentTrick, game.trumpSuit, game.level);
                log(`AI出牌错误，强制纠错`);
                game.playCard(player, forcedCards);
                
                // 更新所有AI的记忆
                const leadSuit = game.currentTrick.length > 0 ? getLeadSuit(game.currentTrick[0].cards, game.trumpSuit, game.level) : null;
                for (const aiPlayer of Object.values(aiPlayers)) {
                    aiPlayer.recordPlay(player, forcedCards, leadSuit, game.trumpSuit, game.level);
                }
                
                const fDisplay = forcedCards.map(c => {
                    const d = getCardDisplay(c);
                    return `${d.rank}${d.suit}`;
                }).join(' ');
                log(`${names[player]} 出 ${fDisplay}`);
            } else {
                game.playCard(player, cards);
                
                // 更新所有AI的记忆
                const leadSuit = game.currentTrick.length > 1 ? getLeadSuit(game.currentTrick[0].cards, game.trumpSuit, game.level) : null;
                for (const aiPlayer of Object.values(aiPlayers)) {
                    aiPlayer.recordPlay(player, cards, leadSuit, game.trumpSuit, game.level);
                }
                
                const display = cards.map(c => {
                    const d = getCardDisplay(c);
                    return `${d.rank}${d.suit}`;
                }).join(' ');
                log(`${names[player]} 出 ${display}`);
            }
            
            updateInfo();
            renderPlayArea();
            
            // 继续下一个玩家
            if (game.currentTrick.length < 4) {
                processPlay(order, index + 1);
            } else {
                // 一轮结束
                setTimeout(() => endTrick(), 1000);
            }
        }, 1000);
    }
}

// 玩家出牌
function onHumanPlay() {
    if (!isHumanTurn || selectedCards.length === 0) return;
    
    // 验证出牌
    if (!isValidPlay(game.players.bottom, selectedCards, game.currentTrick, game.trumpSuit, game.level)) {
        log('出牌不合法，请重新选择');
        return;
    }
    
    isHumanTurn = false;
    game.playCard('bottom', selectedCards);
    
    // 更新所有AI的记忆
    const leadSuit = game.currentTrick.length > 1 ? getLeadSuit(game.currentTrick[0].cards, game.trumpSuit, game.level) : null;
    for (const aiPlayer of Object.values(aiPlayers)) {
        aiPlayer.recordPlay('bottom', selectedCards, leadSuit, game.trumpSuit, game.level);
    }
    
    const display = selectedCards.map(c => {
        const d = getCardDisplay(c);
        return `${d.rank}${d.suit}`;
    }).join(' ');
    log(`你 出 ${display}`);
    
    selectedCards = [];
    updateInfo();
    renderHand();
    renderPlayArea();
    
    // 继续下一个玩家
    const order = getPlayOrder();
    const idx = order.indexOf('bottom');
    
    if (game.currentTrick.length < 4) {
        processPlay(order, idx + 1);
    } else {
        setTimeout(() => endTrick(), 1000);
    }
}

// 一轮结束
function endTrick() {
    const result = game.endTrick();
    
    const names = { bottom: '你', left: 'AI-左', top: 'AI-上', right: 'AI-右' };
    log(`本轮 ${names[result.winner]} 获胜，得分 ${result.score}，我方${result.teamAScore} - 对方${result.teamBScore}`);
    
    showTrickWinner(result.winner);
    updateInfo();
    
    // 清除出牌区域
    setTimeout(() => {
        for (const slot of Object.values(elements.playSlots)) {
            slot.innerHTML = '';
        }
        
        // 检查是否一局结束
        if (game.players.bottom.length === 0) {
            setTimeout(() => endRound(), 500);
        } else {
            // 继续下一轮，从赢家开始
            const order = getWinnerOrder(result.winner);
            processPlay(order, 0);
        }
    }, 1500);
}

// 获取从赢家开始的顺序
function getWinnerOrder(winner) {
    const idx = PLAYERS.indexOf(winner);
    return [...PLAYERS.slice(idx), ...PLAYERS.slice(0, idx)];
}

// 一局结束
function endRound() {
    const result = game.endRound();
    
    const dealerTeamName = result.dealerTeam === 'teamA' ? '我方' : '对方';
    const attackerTeamName = result.attackerTeam === 'teamA' ? '我方' : '对方';
    
    log(`======== 本局结束 ========`);
    log(`庄家方(${dealerTeamName})得分: ${result.dealerScore}`);
    log(`闲家方(${attackerTeamName})得分: ${result.attackerScore} (含底牌${result.kittyScore}分)`);
    
    if (result.attackerScore >= 80) {
        log(`闲家上台！升 ${result.upgrade} 级`);
    } else {
        log(`庄家守庄成功！升 ${result.upgrade} 级`);
    }
    
    // 显示结果弹窗
    showGameOverModal(result);
}

// 显示游戏结束弹窗
function showGameOverModal(result) {
    const dealerTeamName = result.dealerTeam === 'teamA' ? '我方' : '对方';
    const attackerTeamName = result.attackerTeam === 'teamA' ? '我方' : '对方';
    
    let title, detail;
    
    if (result.attackerScore >= 80) {
        title = '闲家获胜！';
        detail = `
            <div class="result-detail">
                <p>闲家方(${attackerTeamName})成功上台！</p>
                <p>闲家得分: <span>${result.attackerScore}</span> (含底牌${result.kittyScore}分)</p>
                <p>庄家得分: <span>${result.dealerScore}</span></p>
                <p>升级: <span>${result.upgrade}</span> 级</p>
                <p>我方当前级别: <span>${game.teamLevels.teamA}</span></p>
                <p>对方当前级别: <span>${game.teamLevels.teamB}</span></p>
            </div>
        `;
    } else {
        title = '庄家守庄成功！';
        detail = `
            <div class="result-detail">
                <p>庄家方(${dealerTeamName})成功守庄！</p>
                <p>闲家得分: <span>${result.attackerScore}</span></p>
                <p>庄家得分: <span>${result.dealerScore}</span> (含底牌${result.kittyScore}分)</p>
                <p>升级: <span>${result.upgrade}</span> 级</p>
                <p>我方当前级别: <span>${game.teamLevels.teamA}</span></p>
                <p>对方当前级别: <span>${game.teamLevels.teamB}</span></p>
            </div>
        `;
    }
    
    elements.gameoverTitle.textContent = title;
    elements.gameoverResult.innerHTML = detail;
    elements.gameoverModal.classList.add('show');
    
    // 检查整局游戏是否结束
    const winner = game.checkGameOver();
    if (winner) {
        elements.nextGame.textContent = '新游戏';
        log(`======== 游戏结束！${winner === 'teamA' ? '我方' : '对方'}获胜！ ========`);
    } else {
        elements.nextGame.textContent = '下一局';
    }
}

// 下一局
function nextGame() {
    elements.gameoverModal.classList.remove('show');
    
    const winner = game.checkGameOver();
    if (winner) {
        // 重新开始
        game.reset();
        for (const ai of Object.values(aiPlayers)) {
            ai.reset();
        }
    }
    
    startRound();
}

// 强制出合法牌（AI出错时的回退）
function forceValidPlay(hand, trickCards, trumpSuit, level) {
    // 首家出牌：出最小的单张
    if (trickCards.length === 0) {
        const sorted = [...hand].sort((a, b) => getCardValue(a, trumpSuit, level) - getCardValue(b, trumpSuit, level));
        return [sorted[0]];
    }

    const leadCards = trickCards[0].cards;
    const leadPattern = getCardPattern(leadCards, trumpSuit, level);
    const leadSuit = getLeadSuit(leadCards, trumpSuit, level);
    const needLen = leadPattern.length;

    // === 首家出主牌 → 必须跟主牌 ===
    if (leadSuit === null) {
        const trumps = [...hand].filter(c => isTrump(c, trumpSuit, level))
            .sort((a, b) => getCardValue(a, trumpSuit, level) - getCardValue(b, trumpSuit, level));

        if (trumps.length >= needLen) {
            // 对子：优先出主牌对子
            if (leadPattern.type === 'pair') {
                const pairs = findPairsInCards(trumps, trumpSuit, level);
                if (pairs.length > 0) return pairs[0];
            }
            // 拖拉机：优先出主牌拖拉机或对子
            if (leadPattern.type === 'tractor') {
                const pairs = findPairsInCards(trumps, trumpSuit, level);
                if (pairs.length >= needLen / 2) {
                    const result = [];
                    for (let i = 0; i < needLen / 2; i++) result.push(...pairs[i]);
                    return result;
                }
            }
            return trumps.slice(0, needLen);
        }
        // 主牌不够，补副牌
        const result = [...trumps];
        const rest = [...hand].filter(c => !isTrump(c, trumpSuit, level))
            .sort((a, b) => getCardValue(a, trumpSuit, level) - getCardValue(b, trumpSuit, level));
        while (result.length < needLen && rest.length > 0) {
            result.push(rest.shift());
        }
        return result;
    }

    // === 首家出副牌 ===
    const leadSuitCards = [...hand].filter(c =>
        !c.isJoker && c.suit === leadSuit && !isTrump(c, trumpSuit, level)
    ).sort((a, b) => getCardValue(a, trumpSuit, level) - getCardValue(b, trumpSuit, level));

    if (leadSuitCards.length > 0) {
        // 有该花色 → 必须跟

        // 对子跟牌：有对子必须出对子
        if (leadPattern.type === 'pair' && leadSuitCards.length >= 2) {
            const pairs = findPairsInCards(leadSuitCards, trumpSuit, level);
            if (pairs.length > 0) {
                return pairs[0]; // 最小对子
            }
            // 没有对子，出最小的两张
            return leadSuitCards.slice(0, Math.min(2, leadSuitCards.length));
        }

        // 拖拉机跟牌：优先出对子
        if (leadPattern.type === 'tractor' && leadSuitCards.length >= 2) {
            const pairs = findPairsInCards(leadSuitCards, trumpSuit, level);
            const result = [];
            if (pairs.length > 0) {
                // 先出对子
                for (const pair of pairs) {
                    result.push(...pair);
                    if (result.length >= needLen) break;
                }
            }
            // 不够的用单张补
            const used = new Set(result.map(c => c.id));
            const remaining = leadSuitCards.filter(c => !used.has(c.id));
            while (result.length < needLen && remaining.length > 0) {
                result.push(remaining.shift());
            }
            return result.slice(0, needLen);
        }

        // 单张跟牌
        if (leadSuitCards.length >= needLen) {
            return leadSuitCards.slice(0, needLen);
        }

        // 花色牌不够，补其他牌
        const result = [...leadSuitCards];
        const rest = [...hand].filter(c =>
            !leadSuitCards.some(lc => lc.id === c.id)
        ).sort((a, b) => getCardValue(a, trumpSuit, level) - getCardValue(b, trumpSuit, level));
        while (result.length < needLen && rest.length > 0) {
            result.push(rest.shift());
        }
        return result;
    }

    // === 没有首家花色 → 可以垫牌或杀主 ===
    // 尝试用主牌杀（如果主牌足够且是同型）
    const trumps = [...hand].filter(c => isTrump(c, trumpSuit, level))
        .sort((a, b) => getCardValue(a, trumpSuit, level) - getCardValue(b, trumpSuit, level));

    if (leadPattern.type === 'pair' && trumps.length >= needLen) {
        const pairs = findPairsInCards(trumps, trumpSuit, level);
        if (pairs.length > 0) return pairs[0];
        return trumps.slice(0, needLen);
    }

    if (leadPattern.type === 'tractor' && trumps.length >= needLen) {
        const pairs = findPairsInCards(trumps, trumpSuit, level);
        if (pairs.length >= needLen / 2) {
            const result = [];
            for (let i = 0; i < needLen / 2; i++) result.push(...pairs[i]);
            return result;
        }
    }

    // 垫最小的副牌（不要分牌优先）
    const nonTrumps = [...hand].filter(c => !isTrump(c, trumpSuit, level))
        .sort((a, b) => getCardValue(a, trumpSuit, level) - getCardValue(b, trumpSuit, level));
    if (nonTrumps.length >= needLen) return nonTrumps.slice(0, needLen);

    // 副牌不够，用主牌补
    const result = [...nonTrumps];
    while (result.length < needLen && trumps.length > 0) {
        result.push(trumps.shift());
    }
    return result;
}

// 初始化
function init() {
    initElements();
    
    elements.startGame.addEventListener('click', startGame);
    elements.nextGame.addEventListener('click', nextGame);
    
    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && isHumanTurn) {
            onHumanPlay();
        }
    });
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);

// 辅助函数：判断是否是主牌（避免与函数名冲突）
function isTrumpCard(card, trumpSuit, level) {
    if (card.isJoker) return true;
    if (card.rank === level) return true;
    if (card.suit === trumpSuit) return true;
    return false;
}