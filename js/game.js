/**
 * 拖拉机 - 游戏核心逻辑
 */

// 花色定义
const SUITS = {
    SPADES: 'spades',
    HEARTS: 'hearts',
    CLUBS: 'clubs',
    DIAMONDS: 'diamonds',
    JOKER: 'joker'
};

// 花色显示
const SUIT_SYMBOLS = {
    [SUITS.SPADES]: '♠',
    [SUITS.HEARTS]: '♥',
    [SUITS.CLUBS]: '♣',
    [SUITS.DIAMONDS]: '♦',
    [SUITS.JOKER]: '🃏'
};

// 点数定义
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const JOKER_RANKS = ['small', 'big']; // 小王、大王

// 玩家位置（出牌顺序：玩家 → 下家 → 对家 → 上家）
const PLAYERS = ['bottom', 'right', 'top', 'left'];

// 队伍
const TEAMS = {
    TEAM_A: ['bottom', 'top'],   // 我方：玩家 + 对家
    TEAM_B: ['left', 'right']    // 对方：上家 + 下家
};

// 叫主类型
const BID_TYPES = {
    SINGLE: 'single',                    // 单张级牌叫主
    PAIR_LEVEL: 'pair_level',            // 对级牌反主
    PAIR_SMALL_JOKER: 'pair_small_joker', // 对小王反主（无主）
    PAIR_BIG_JOKER: 'pair_big_joker'     // 对大王反主（无主）
};

// 叫主等级（power越大越能反）
const BID_POWER = {
    [BID_TYPES.SINGLE]: 1,
    [BID_TYPES.PAIR_LEVEL]: 2,
    [BID_TYPES.PAIR_SMALL_JOKER]: 3,
    [BID_TYPES.PAIR_BIG_JOKER]: 4
};

/**
 * 创建一副牌
 */
function createDeck() {
    const deck = [];
    let id = 0;
    
    // 创建2副牌
    for (let deckIndex = 0; deckIndex < 2; deckIndex++) {
        // 四种花色
        for (const suit of [SUITS.SPADES, SUITS.HEARTS, SUITS.CLUBS, SUITS.DIAMONDS]) {
            for (const rank of RANKS) {
                deck.push({
                    id: id++,
                    suit: suit,
                    rank: rank,
                    isJoker: false,
                    deckIndex: deckIndex
                });
            }
        }
        
        // 大小王
        for (const rank of JOKER_RANKS) {
            deck.push({
                id: id++,
                suit: SUITS.JOKER,
                rank: rank,
                isJoker: true,
                deckIndex: deckIndex
            });
        }
    }
    
    return deck;
}

/**
 * 洗牌
 */
function shuffleDeck(deck) {
    const shuffled = [...deck];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

/**
 * 获取牌的显示信息
 */
function getCardDisplay(card) {
    if (card.isJoker) {
        return {
            rank: card.rank === 'big' ? '大王' : '小王',
            suit: '🃏',
            color: card.rank === 'big' ? 'red' : 'gray'
        };
    }
    
    const rankMap = {
        'J': 'J', 'Q': 'Q', 'K': 'K', 'A': 'A', '2': '2'
    };
    
    const color = (card.suit === SUITS.HEARTS || card.suit === SUITS.DIAMONDS) ? 'red' : 'black';
    
    return {
        rank: rankMap[card.rank] || card.rank,
        suit: SUIT_SYMBOLS[card.suit],
        color: color
    };
}

/**
 * 查找手牌中的对级牌（同花色两张级牌，来自不同副牌）
 */
function findLevelPairs(hand, level) {
    const levelCards = hand.filter(c => !c.isJoker && c.rank === level);
    const pairs = [];
    const used = new Set();
    
    for (let i = 0; i < levelCards.length; i++) {
        if (used.has(levelCards[i].id)) continue;
        for (let j = i + 1; j < levelCards.length; j++) {
            if (used.has(levelCards[j].id)) continue;
            if (levelCards[i].suit === levelCards[j].suit && levelCards[i].deckIndex !== levelCards[j].deckIndex) {
                pairs.push([levelCards[i], levelCards[j]]);
                used.add(levelCards[i].id);
                used.add(levelCards[j].id);
                break;
            }
        }
    }
    return pairs;
}

/**
 * 查找手牌中的王对（是否有至少两张指定类型的王）
 */
function findJokerPairs(hand, jokerRank) {
    const jokers = hand.filter(c => c.isJoker && c.rank === jokerRank);
    return jokers.length >= 2 ? jokers.slice(0, 2) : [];
}

/**
 * 判断新的叫主是否可以反掉当前的叫主
 */
function canCounterBid(currentBid, newBidType) {
    if (!currentBid) return true;
    return BID_POWER[newBidType] > currentBid.power;
}

/**
 * 获取玩家所有可进行的叫主/反主选项
 * @returns {Array} 可进行的叫主选项列表
 */
function getAvailableBids(hand, level, currentBid) {
    const bids = [];
    
    // 1. 单张级牌叫主（只有当前无主时才能叫）
    if (!currentBid) {
        const levelCards = hand.filter(c => !c.isJoker && c.rank === level);
        const seenSuits = new Set();
        for (const card of levelCards) {
            if (!seenSuits.has(card.suit)) {
                seenSuits.add(card.suit);
                bids.push({
                    type: BID_TYPES.SINGLE,
                    suit: card.suit,
                    power: BID_POWER[BID_TYPES.SINGLE],
                    cards: [card],
                    display: `${SUIT_SYMBOLS[card.suit]}${level}`
                });
            }
        }
    }
    
    // 2. 对级牌反主
    const levelPairs = findLevelPairs(hand, level);
    for (const pair of levelPairs) {
        if (canCounterBid(currentBid, BID_TYPES.PAIR_LEVEL)) {
            bids.push({
                type: BID_TYPES.PAIR_LEVEL,
                suit: pair[0].suit,
                power: BID_POWER[BID_TYPES.PAIR_LEVEL],
                cards: pair,
                display: `对${SUIT_SYMBOLS[pair[0].suit]}${level}`
            });
        }
    }
    
    // 3. 对小王反主（无主）
    const smallJokerPair = findJokerPairs(hand, 'small');
    if (smallJokerPair.length >= 2 && canCounterBid(currentBid, BID_TYPES.PAIR_SMALL_JOKER)) {
        bids.push({
            type: BID_TYPES.PAIR_SMALL_JOKER,
            suit: null,
            power: BID_POWER[BID_TYPES.PAIR_SMALL_JOKER],
            cards: smallJokerPair,
            display: '对小王（无主）'
        });
    }
    
    // 4. 对大王反主（无主）
    const bigJokerPair = findJokerPairs(hand, 'big');
    if (bigJokerPair.length >= 2 && canCounterBid(currentBid, BID_TYPES.PAIR_BIG_JOKER)) {
        bids.push({
            type: BID_TYPES.PAIR_BIG_JOKER,
            suit: null,
            power: BID_POWER[BID_TYPES.PAIR_BIG_JOKER],
            cards: bigJokerPair,
            display: '对大王（无主）'
        });
    }
    
    return bids;
}

/**
 * 判断牌是否为主牌
 */
function isTrump(card, trumpSuit, level) {
    if (card.isJoker) return true;
    if (card.rank === level) return true;
    if (card.suit === trumpSuit) return true;
    return false;
}

/**
 * 获取牌的点数价值（用于比较大小）
 * 返回值越大，牌越大
 */
function getCardValue(card, trumpSuit, level) {
    // 大王
    if (card.isJoker && card.rank === 'big') return 1000;
    // 小王
    if (card.isJoker && card.rank === 'small') return 999;
    
    // 主2（如果当前打2，则2是级牌，但不是常主2的情况？不，2始终是常主）
    // 实际上2始终是主牌（常主），级牌也是主牌
    const isTrumpCard = isTrump(card, trumpSuit, level);
    
    if (!isTrumpCard) {
        // 副牌：按点数排序
        const rankIndex = RANKS.indexOf(card.rank);
        return rankIndex; // 3=0, 4=1, ..., A=11, 2=12
    }
    
    // 主牌
    if (card.rank === '2') {
        // 主2 > 副2
        return card.suit === trumpSuit ? 998 : 997;
    }
    
    if (card.rank === level && level !== '2') {
        // 级牌（非2的情况）
        return card.suit === trumpSuit ? 996 : 995;
    }
    
    // 主花色普通牌
    if (card.suit === trumpSuit) {
        const rankIndex = RANKS.indexOf(card.rank);
        return 100 + rankIndex;
    }
    
    // 其他情况（不应该到这里）
    return 0;
}

/**
 * 比较两张牌的大小（假设都是合法的出牌）
 * @returns {number} 1: card1大, -1: card2大, 0: 相等（不应该）
 */
function compareCards(card1, card2, trumpSuit, level, leadSuit) {
    const value1 = getCardValue(card1, trumpSuit, level);
    const value2 = getCardValue(card2, trumpSuit, level);
    
    const isTrump1 = isTrump(card1, trumpSuit, level);
    const isTrump2 = isTrump(card2, trumpSuit, level);
    
    // 第一家出的花色
    if (leadSuit) {
        const isLeadSuit1 = !card1.isJoker && card1.suit === leadSuit && !isTrump1;
        const isLeadSuit2 = !card2.isJoker && card2.suit === leadSuit && !isTrump2;
        
        // 如果两家都跟了首家花色
        if (isLeadSuit1 && isLeadSuit2) {
            return value1 > value2 ? 1 : -1;
        }
        
        // 如果一家跟了首家花色，另一家没有
        if (isLeadSuit1 && !isLeadSuit2) {
            // 另一家如果不是主牌，则垫牌，跟花色的赢
            if (!isTrump2) return 1;
            // 另一家杀主
            return -1;
        }
        if (!isLeadSuit1 && isLeadSuit2) {
            if (!isTrump1) return -1;
            return 1;
        }
    }
    
    // 都是主牌或都垫牌，直接比大小
    return value1 > value2 ? 1 : -1;
}

/**
 * 判断牌型
 */
function getCardPattern(cards, trumpSuit, level) {
    if (cards.length === 0) return null;
    if (cards.length === 1) return { type: 'single', length: 1 };
    
    // 检查是否是对子
    if (cards.length === 2) {
        if (cards[0].rank === cards[1].rank && 
            cards[0].suit === cards[1].suit &&
            cards[0].deckIndex !== cards[1].deckIndex) {
            return { type: 'pair', length: 2 };
        }
        return { type: 'invalid', length: 2 };
    }
    
    // 检查是否是拖拉机（连对）
    if (cards.length >= 4 && cards.length % 2 === 0) {
        // 排序
        const sorted = [...cards].sort((a, b) => getCardValue(a, trumpSuit, level) - getCardValue(b, trumpSuit, level));
        
        // 检查是否都是对子且连续
        const pairs = [];
        for (let i = 0; i < sorted.length; i += 2) {
            if (i + 1 < sorted.length &&
                sorted[i].rank === sorted[i+1].rank &&
                sorted[i].suit === sorted[i+1].suit &&
                sorted[i].deckIndex !== sorted[i+1].deckIndex) {
                pairs.push(sorted[i]);
            } else {
                return { type: 'invalid', length: cards.length };
            }
        }
        
        // 检查连续性
        for (let i = 0; i < pairs.length - 1; i++) {
            const idx1 = RANKS.indexOf(pairs[i].rank);
            const idx2 = RANKS.indexOf(pairs[i+1].rank);
            // 必须同花色，且是相邻点数
            if (pairs[i].suit !== pairs[i+1].suit || idx2 - idx1 !== 1) {
                return { type: 'invalid', length: cards.length };
            }
        }
        
        return { type: 'tractor', length: cards.length };
    }
    
    return { type: 'invalid', length: cards.length };
}

/**
 * 检查出牌是否合法
 */
function isValidPlay(playerCards, playedCards, trickCards, trumpSuit, level) {
    if (playedCards.length === 0) return false;

    // 首家出牌
    if (trickCards.length === 0) {
        const pattern = getCardPattern(playedCards, trumpSuit, level);
        return pattern.type !== 'invalid';
    }

    // 非首家，需要跟牌
    const leadCards = trickCards[0].cards;
    const leadPattern = getCardPattern(leadCards, trumpSuit, level);
    const leadSuit = getLeadSuit(leadCards, trumpSuit, level);

    const playedPattern = getCardPattern(playedCards, trumpSuit, level);

    // 出的牌型必须和首家一致
    if (playedPattern.type !== leadPattern.type || playedPattern.length !== leadPattern.length) {
        return false;
    }

    // 首家出的是主牌 → 所有人必须跟主牌
    if (leadSuit === null) {
        const playedTrump = playedCards.filter(c => isTrump(c, trumpSuit, level));
        // 必须出同样数量的主牌
        return playedTrump.length === playedCards.length;
    }

    // 首家出的是副牌 → 检查是否有该花色
    const leadSuitNonTrump = playerCards.filter(c =>
        !c.isJoker && c.suit === leadSuit && !isTrump(c, trumpSuit, level)
    );

    if (leadSuitNonTrump.length > 0) {
        // 有首家花色，必须跟
        const playedLeadSuit = playedCards.filter(c =>
            !c.isJoker && c.suit === leadSuit && !isTrump(c, trumpSuit, level)
        );
        const neededCount = Math.min(leadSuitNonTrump.length, leadPattern.length);
        // 至少要跟尽量多的该花色牌
        if (playedLeadSuit.length < neededCount) {
            return false;
        }

        // === 对子跟牌规则：如果首家出对子，且玩家有该花色的对子，必须出至少一个对子 ===
        if (leadPattern.type === 'pair' && leadSuitNonTrump.length >= 2) {
            const playerPairs = findPairsInCards(leadSuitNonTrump, trumpSuit, level);
            if (playerPairs.length > 0) {
                // 玩家该花色有对子，则出的牌中必须包含至少一个该花色对子
                // 除非玩家该花色全部牌不足两张（不可能，因为上面已检查>=2）
                const playedPairs = findPairsInCards(playedLeadSuit, trumpSuit, level);
                if (playedPairs.length === 0 && playedLeadSuit.length >= 2) {
                    // 出了两张以上该花色牌但没有对子，且手中原本有对子 → 不合法
                    // 除非玩家该花色只有单张（不可能因为leadSuitNonTrump>=2且playerPairs>0意味着至少有一对）
                    return false;
                }
            }
        }

        // === 拖拉机跟牌规则：如果首家出拖拉机，玩家有该花色对子时必须优先出对子 ===
        if (leadPattern.type === 'tractor' && leadSuitNonTrump.length >= 2) {
            const playerPairs = findPairsInCards(leadSuitNonTrump, trumpSuit, level);
            if (playerPairs.length > 0) {
                // 有对子时，出的牌中该花色的对子数量应尽量多
                const playedPairs = findPairsInCards(playedLeadSuit, trumpSuit, level);
                const needPairs = Math.min(playerPairs.length, leadPattern.length / 2);
                // 如果出的该花色牌数量足够组成对子但没出对子 → 不合法
                if (playedPairs.length === 0 && playedLeadSuit.length >= 2) {
                    return false;
                }
            }
        }
    }
    // 没有首家花色，可以垫牌或杀主，牌型一致即可
    // （已经通过 playedPattern 检查了牌型）

    return true;
}

/**
 * 在给定牌中查找对子（同花色同点数，不同副牌）
 */
function findPairsInCards(cards, trumpSuit, level) {
    const pairs = [];
    const used = new Set();
    for (let i = 0; i < cards.length; i++) {
        if (used.has(i)) continue;
        for (let j = i + 1; j < cards.length; j++) {
            if (used.has(j)) continue;
            if (cards[i].rank === cards[j].rank &&
                cards[i].suit === cards[j].suit &&
                cards[i].deckIndex !== cards[j].deckIndex) {
                pairs.push([cards[i], cards[j]]);
                used.add(i);
                used.add(j);
                break;
            }
        }
    }
    return pairs;
}

/**
 * 获取首家出的花色
 */
function getLeadSuit(cards, trumpSuit, level) {
    if (cards.length === 0) return null;
    const card = cards[0];
    if (isTrump(card, trumpSuit, level)) return null; // 主牌无花色
    return card.suit;
}

/**
 * 判断本轮赢家
 */
function getTrickWinner(trickCards, trumpSuit, level) {
    if (trickCards.length === 0) return null;
    
    const leadCards = trickCards[0].cards;
    const leadSuit = getLeadSuit(leadCards, trumpSuit, level);
    
    let winner = trickCards[0];
    let maxValue = getCardValue(leadCards[0], trumpSuit, level);
    let winnerIsTrump = isTrump(leadCards[0], trumpSuit, level);
    
    for (let i = 1; i < trickCards.length; i++) {
        const cards = trickCards[i].cards;
        const card = cards[0]; // 对于对子和拖拉机，比较第一张即可（因为同型）
        
        const cardIsTrump = isTrump(card, trumpSuit, level);
        const cardValue = getCardValue(card, trumpSuit, level);
        
        // 如果之前不是主牌，现在是主牌，则现在的大
        if (!winnerIsTrump && cardIsTrump) {
            winner = trickCards[i];
            maxValue = cardValue;
            winnerIsTrump = true;
            continue;
        }
        
        // 如果之前是主牌，现在不是，则跳过
        if (winnerIsTrump && !cardIsTrump) {
            continue;
        }
        
        // 同为主牌或同为副牌，比较大小
        if (cardValue > maxValue) {
            winner = trickCards[i];
            maxValue = cardValue;
        }
    }
    
    return winner;
}

/**
 * 计算牌中的分数
 */
function getCardScore(cards) {
    let score = 0;
    for (const card of cards) {
        if (card.rank === '5') score += 5;
        else if (card.rank === '10' || card.rank === 'K') score += 10;
    }
    return score;
}

/**
 * 计算升级
 */
function calculateUpgrade(score, isDealerTeam) {
    if (isDealerTeam) {
        // 庄家方
        if (score === 0) return 3;
        if (score <= 35) return 2;
        if (score <= 75) return 1;
        return 0; // 下台
    } else {
        // 闲家
        if (score < 80) return 0; // 没上台
        if (score <= 115) return 1;
        if (score <= 155) return 2;
        if (score <= 195) return 3;
        return 4; // 200分
    }
}

/**
 * 获取下一个级别
 */
function getNextLevel(currentLevel, upgrade) {
    const levels = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const idx = levels.indexOf(currentLevel);
    const newIdx = Math.min(idx + upgrade, levels.length - 1);
    return levels[newIdx];
}

// 游戏状态
class GameState {
    constructor() {
        this.reset();
    }
    
    reset() {
        this.deck = [];
        this.players = {
            bottom: [],
            left: [],
            top: [],
            right: []
        };
        this.kitty = []; // 底牌
        this.trumpSuit = null;
        this.level = '2';
        this.dealer = null; // 庄家，null表示未确定（第一轮）
        this.scores = {
            teamA: 0, // 当前局得分
            teamB: 0
        };
        this.teamLevels = {
            teamA: '2',
            teamB: '2'
        };
        this.currentTrick = []; // 当前轮出的牌
        this.trickLeader = null; // 首家
        this.tricksPlayed = 0;
        this.phase = 'idle'; // idle, dealing, bidding, burying, playing, ended
        this.trickScores = { teamA: 0, teamB: 0 }; // 本轮得分
        
        // 叫主状态
        this.bidState = {
            currentBid: null,      // 当前最高叫主 {player, type, suit, power, cards}
            bidHistory: [],        // 叫主历史记录
            dealerConfirmed: false // 庄家是否已确定
        };
    }
    
    deal() {
        this.deck = shuffleDeck(createDeck());
        this.players.bottom = this.deck.slice(0, 25);
        this.players.left = this.deck.slice(25, 50);
        this.players.top = this.deck.slice(50, 75);
        this.players.right = this.deck.slice(75, 100);
        this.kitty = this.deck.slice(100, 108);
        
        // 排序手牌
        for (const pos of PLAYERS) {
            this.sortHand(pos);
        }
    }
    
    // 逐张发牌支持
    startDealing() {
        this.deck = shuffleDeck(createDeck());
        this.players.bottom = [];
        this.players.left = [];
        this.players.top = [];
        this.players.right = [];
        this.kitty = [];
        this.dealIndex = 0;
    }
    
    dealNextCard() {
        if (this.dealIndex >= 108) return null;
        
        const card = this.deck[this.dealIndex];
        
        if (this.dealIndex < 100) {
            // 前100张发给4个玩家，每人25张，按出牌顺序发牌
            const playerIdx = this.dealIndex % 4;
            const player = PLAYERS[playerIdx]; // bottom→right→top→left
            this.players[player].push(card);
            this.dealIndex++;
            return { player, card, isKitty: false };
        } else {
            // 后8张为底牌
            this.kitty.push(card);
            this.dealIndex++;
            return { player: 'kitty', card, isKitty: true };
        }
    }
    
    isDealingComplete() {
        return this.dealIndex >= 108;
    }
    
    sortHand(position) {
        // 副牌按花色分组排序，主牌统一放最右侧
        const suitOrder = {
            [SUITS.SPADES]: 0,
            [SUITS.HEARTS]: 1,
            [SUITS.CLUBS]: 2,
            [SUITS.DIAMONDS]: 3
        };
        
        this.players[position].sort((a, b) => {
            const aTrump = isTrump(a, this.trumpSuit, this.level);
            const bTrump = isTrump(b, this.trumpSuit, this.level);
            
            // 主牌放最右边（group=4），副牌按花色分组
            const aGroup = aTrump ? 4 : (suitOrder[a.suit] !== undefined ? suitOrder[a.suit] : 5);
            const bGroup = bTrump ? 4 : (suitOrder[b.suit] !== undefined ? suitOrder[b.suit] : 5);
            
            if (aGroup !== bGroup) {
                return aGroup - bGroup;
            }
            
            // 同组内按大小排序
            const va = getCardValue(a, this.trumpSuit, this.level);
            const vb = getCardValue(b, this.trumpSuit, this.level);
            return va - vb;
        });
    }
    
    setTrump(suit) {
        this.trumpSuit = suit;  // suit为null表示无主
        // 重新排序手牌
        for (const pos of PLAYERS) {
            this.sortHand(pos);
        }
    }
    
    /**
     * 执行叫主/反主
     * @param {string} player - 叫主玩家
     * @param {Object} bidInfo - 叫主信息 {type, suit, power, cards}
     * @returns {boolean} 是否成功
     */
    makeBid(player, bidInfo) {
        // 检查是否可以反主
        if (this.bidState.currentBid && bidInfo.power <= this.bidState.currentBid.power) {
            return false;
        }
        
        // 记录叫主
        const bidRecord = {
            player: player,
            type: bidInfo.type,
            suit: bidInfo.suit,
            power: bidInfo.power,
            cards: bidInfo.cards,
            display: bidInfo.display || (bidInfo.suit ? SUIT_SYMBOLS[bidInfo.suit] : '无主'),
            time: Date.now()
        };
        
        this.bidState.bidHistory.push(bidRecord);
        this.bidState.currentBid = bidRecord;
        
        // 设置主花色
        this.setTrump(bidInfo.suit);
        
        // 第一轮：第一个叫主的人成为庄家（反主不翻庄）
        if (!this.bidState.dealerConfirmed && this.dealer === null) {
            this.dealer = player;
            this.bidState.dealerConfirmed = true;
        }
        
        return true;
    }
    
    buryCards(cards) {
        // 庄家先拿起底牌（合并手牌）
        this.players[this.dealer] = [...this.players[this.dealer], ...this.kitty];
        
        // 从庄家手牌中移除要埋的牌
        const dealerHand = this.players[this.dealer];
        for (const card of cards) {
            const idx = dealerHand.findIndex(c => c.id === card.id);
            if (idx !== -1) {
                dealerHand.splice(idx, 1);
            }
        }
        
        // 埋的牌成为新的底牌
        this.kitty = cards;
        
        // 重新排序
        this.sortHand(this.dealer);
    }
    
    playCard(position, cards) {
        // 从手牌移除
        const hand = this.players[position];
        for (const card of cards) {
            const idx = hand.findIndex(c => c.id === card.id);
            if (idx !== -1) {
                hand.splice(idx, 1);
            }
        }
        
        // 记录出牌
        this.currentTrick.push({
            player: position,
            cards: cards
        });
        
        // 设置首家
        if (this.currentTrick.length === 1) {
            this.trickLeader = position;
        }
    }
    
    endTrick() {
        const winner = getTrickWinner(this.currentTrick, this.trumpSuit, this.level);
        const score = getCardScore(this.currentTrick.flatMap(t => t.cards));
        
        // 计算哪方得分
        const isTeamA = TEAMS.TEAM_A.includes(winner.player);
        if (isTeamA) {
            this.trickScores.teamA += score;
        } else {
            this.trickScores.teamB += score;
        }
        
        this.tricksPlayed++;
        
        const result = {
            winner: winner.player,
            score: score,
            teamAScore: this.trickScores.teamA,
            teamBScore: this.trickScores.teamB
        };
        
        this.currentTrick = [];
        this.trickLeader = winner.player;
        
        return result;
    }
    
    endRound() {
        // 最后一轮赢家获得底牌分数
        const lastWinner = this.trickLeader;
        const isTeamA = TEAMS.TEAM_A.includes(lastWinner);
        const kittyScore = getCardScore(this.kitty);
        
        if (isTeamA) {
            this.trickScores.teamA += kittyScore;
        } else {
            this.trickScores.teamB += kittyScore;
        }
        
        // 判断胜负
        const dealerTeam = TEAMS.TEAM_A.includes(this.dealer) ? 'teamA' : 'teamB';
        const attackerTeam = dealerTeam === 'teamA' ? 'teamB' : 'teamA';
        const dealerTeamMembers = dealerTeam === 'teamA' ? TEAMS.TEAM_A : TEAMS.TEAM_B;
        
        const dealerScore = this.trickScores[dealerTeam];
        const attackerScore = this.trickScores[attackerTeam];
        
        let result = {
            dealerTeam: dealerTeam,
            attackerTeam: attackerTeam,
            dealerScore: dealerScore,
            attackerScore: attackerScore,
            kittyScore: kittyScore,
            upgrade: 0,
            newDealer: null,
            winner: null
        };
        
        if (attackerScore >= 80) {
            // 闲家上台：庄家转移到闲家方
            // 规则：新庄家是当前庄家的"下家"（PLAYERS顺序中的下一位）
            const upgrade = calculateUpgrade(attackerScore, false);
            const newLevel = getNextLevel(this.teamLevels[attackerTeam], upgrade);
            this.teamLevels[attackerTeam] = newLevel;
            
            result.upgrade = upgrade;
            result.winner = attackerTeam;
            this.level = newLevel;
            
            // 下家 = PLAYERS顺序中当前庄家的下一位
            const currentDealerIdx = PLAYERS.indexOf(this.dealer);
            result.newDealer = PLAYERS[(currentDealerIdx + 1) % PLAYERS.length];
            this.dealer = result.newDealer;
        } else {
            // 庄家守庄成功：庄家在庄家方队内轮换
            const upgrade = calculateUpgrade(attackerScore, true);
            const newLevel = getNextLevel(this.teamLevels[dealerTeam], upgrade);
            this.teamLevels[dealerTeam] = newLevel;
            
            result.upgrade = upgrade;
            result.winner = dealerTeam;
            this.level = newLevel;
            
            // 庄家在队内轮换：当前庄家的队友成为下一轮庄家
            const currentDealerIdx = dealerTeamMembers.indexOf(this.dealer);
            result.newDealer = dealerTeamMembers[(currentDealerIdx + 1) % dealerTeamMembers.length];
            this.dealer = result.newDealer;
        }
        
        this.phase = 'ended';
        return result;
    }
    
    checkGameOver() {
        if (this.teamLevels.teamA === 'A') return 'teamA';
        if (this.teamLevels.teamB === 'A') return 'teamB';
        return null;
    }
    
    /**
     * 准备下一轮：重置局内状态但保留庄家和级别
     */
    prepareNextRound() {
        this.deck = [];
        for (const pos of PLAYERS) {
            this.players[pos] = [];
        }
        this.kitty = [];
        this.trumpSuit = null;
        this.currentTrick = [];
        this.trickLeader = null;
        this.tricksPlayed = 0;
        this.phase = 'idle';
        this.trickScores = { teamA: 0, teamB: 0 };
        this.bidState = {
            currentBid: null,
            bidHistory: [],
            dealerConfirmed: true  // 后续轮次庄家已确定
        };
    }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        GameState, createDeck, shuffleDeck, getCardDisplay,
        isTrump, getCardValue, compareCards, getCardPattern,
        isValidPlay, getLeadSuit, getTrickWinner, getCardScore,
        calculateUpgrade, getNextLevel,
        findLevelPairs, findJokerPairs, canCounterBid, getAvailableBids,
        BID_TYPES, BID_POWER,
        SUITS, RANKS, PLAYERS, TEAMS, SUIT_SYMBOLS
    };
}