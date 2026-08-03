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
// 2放在最前面：不打2时，2是最小的普通牌（value=RANKS.indexOf('2')=0）
// 打2时，2是级牌，由 getCardValue 特殊处理为主牌（不会走副牌分支）
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
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
// 修正：对小王和对大王都反成无主，不分等级（没有意义），都设为3
const BID_POWER = {
    [BID_TYPES.SINGLE]: 1,
    [BID_TYPES.PAIR_LEVEL]: 2,
    [BID_TYPES.PAIR_SMALL_JOKER]: 3,
    [BID_TYPES.PAIR_BIG_JOKER]: 3
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
 *
 * 主牌的构成（2不作为常主）：
 *   1. 大小王（永远主牌）
 *   2. 级牌（rank === level 的所有花色牌）
 *   3. 主花色牌（suit === trumpSuit，无主时此项为空）
 *
 * 2不是常主：只有 level='2'（打2）时，2才是级牌（主牌）；
 * 不打2时，2就是普通副牌中最小的牌。
 *
 * @param {Object} card - 牌对象
 * @param {string|null} trumpSuit - 主花色，null表示无主
 * @param {string} level - 当前级别（如 '5', 'A', '2'）
 * @returns {boolean}
 */
function isTrump(card, trumpSuit, level) {
    if (card.isJoker) return true;           // 大小王永远是主牌
    if (card.rank === level) return true;    // 级牌是主牌
    if (card.suit === trumpSuit) return true; // 主花色是主牌
    return false;
}

/**
 * 获取牌的点数价值（用于比较大小、排序、拖拉机识别）
 * 返回值越大，牌越大。所有主牌值 > 所有副牌值。
 *
 * ════════════════════════════════════════════════════════════════
 *  完整排序（以打5红桃主为例）：
 * ════════════════════════════════════════════════════════════════
 *
 *  副牌（value 0~12，RANKS数组下标）：
 *    2=0 < 3=1 < 4=2 < 6=3 < 7=4 < 8=5 < 9=6 < 10=7
 *    < J=8 < Q=9 < K=10 < A=11
 *    （5是级牌被提取为主牌，不在副牌序列中）
 *
 *  主牌（value 200~215，连续递增保证拖拉机相邻性）：
 *    主花色普通牌（跳过级牌，200~211）：
 *      红2=200 < 红3=201 < 红4=202 < 红6=203 < 红7=204
 *      < 红8=205 < 红9=206 < 红10=207 < 红J=208 < 红Q=209
 *      < 红K=210 < 红A=211
 *      （5被提取为级牌，4和6相邻形成拖拉机）
 *    副级牌（所有非主花色的级牌）: 212
 *      黑5=212, 梅5=212, 方5=212
 *    主级牌（主花色的级牌）: 213
 *      红5=213
 *    小王: 214
 *    大王: 215
 *
 *  主牌之间相邻关系（差值=1即可形成拖拉机）：
 *    红4(202) ↔ 红6(203)     级牌5被跳过，4和6相邻
 *    红A(211) ↔ 副级5(212)    主花色最大牌和副级牌相邻
 *    副级5(212) ↔ 主级5(213)  副级牌和主级牌相邻
 *    主级5(213) ↔ 小王(214)   主级牌和小王相邻
 *    小王(214) ↔ 大王(215)    小王和大王相邻
 *
 *  特殊情况 — 打2时（level='2'）：
 *    所有2都是级牌（主牌），副级2=212，主级2=213
 *    副牌最小是3（value=1），主花色最小是3（value=200）
 *
 *  特殊情况 — 无主时（trumpSuit=null）：
 *    只有级牌和王是主牌，所有级牌value=212（不分主副）
 *
 * @param {Object} card - 牌对象
 * @param {string|null} trumpSuit - 主花色，null表示无主
 * @param {string} level - 当前级别
 * @returns {number} 牌的价值
 */
function getCardValue(card, trumpSuit, level) {
    // 大小王：最高主牌
    if (card.isJoker && card.rank === 'big') return 215;
    if (card.isJoker && card.rank === 'small') return 214;

    const isTrumpCard = isTrump(card, trumpSuit, level);

    if (!isTrumpCard) {
        // 副牌：按RANKS数组下标排序
        // RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A']
        // 不打2时2是最小（index=0）；打2时2是级牌不会进入这里
        return RANKS.indexOf(card.rank);
    }

    // === 以下为主牌 ===

    // 级牌：副级牌(212) < 主级牌(213)
    if (card.rank === level) {
        return card.suit === trumpSuit ? 213 : 212;
    }

    // 主花色普通牌（200~211，跳过级牌保证连续性）
    if (card.suit === trumpSuit) {
        const rankIndex = RANKS.indexOf(card.rank);
        const levelIndex = RANKS.indexOf(level);
        // 级牌被提取到212/213，普通主花色牌需要填补空缺保持连续
        // rank在级牌之上的减1，rank在级牌之下的不变
        const adjustedIndex = rankIndex > levelIndex ? rankIndex - 1 : rankIndex;
        return 200 + adjustedIndex;
    }

    // 无主时的级牌（trumpSuit=null，非主花色判断）
    return 212;
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
 *
 * 牌型类型：
 *   - single: 单张（1张）
 *   - pair: 对子（2张，同花色同点数不同副牌，或同等级的王）
 *   - tractor: 拖拉机/连对（4张及以上偶数张，相邻对子组成）
 *   - throw: 甩牌（2张以上，不构成对子或拖拉机，但都是该门副牌中剩余最大的牌）
 *   - invalid: 非法牌型
 *
 * 拖拉机规则（相邻 = getCardValue差值=1）：
 *   副牌拖拉机：同花色相邻点数的连对
 *     如 红桃4455（打5时4和6相邻）、黑桃KKAA
 *   主牌拖拉机：主牌内部相邻的连对，跨类型也算
 *     主花色AA对 + 副级牌对   (211 ↔ 212)
 *     副级牌对 + 主级牌对     (212 ↔ 213)
 *     主级牌对 + 小王对       (213 ↔ 214)
 *     小王对 + 大王对         (214 ↔ 215)
 *     打2时：主2对(213) + 小王对(214) 也算
 *
 * 甩牌规则：
 *   某门副牌中，手上的牌无论单双，都是市面上该门副牌里最大的，
 *   则可以一手打出。不要求是对子或拖拉机。
 *   判据：甩出的牌面里最小的那张，比它大的同门牌必须都已出过或也在甩牌中。
 *   例：市面上已出A-A-K-K（两副的A和K全出），手上有Q-J-10-10，可甩出——
 *   最小的是10，比10大的J/Q/K/A中，K和A已出，J和Q在甩牌中。
 *   杀甩牌条件：全主牌 + 张数相同 + 对子数≥甩牌中的对子数。
 */
function getCardPattern(cards, trumpSuit, level, playedCardsHistory) {
    if (cards.length === 0) return null;
    if (cards.length === 1) return { type: 'single', length: 1 };

    // 检查是否是对子
    if (cards.length === 2) {
        if (isCardPair(cards[0], cards[1], trumpSuit, level)) {
            return { type: 'pair', length: 2 };
        }
        // 2张不是对子，检查是否是甩牌
        if (isThrowValid(cards, trumpSuit, level, playedCardsHistory)) {
            return { type: 'throw', length: 2 };
        }
        return { type: 'invalid', length: 2 };
    }

    // 检查是否是拖拉机（连对）
    if (cards.length >= 4 && cards.length % 2 === 0) {
        // 按主牌值排序
        const sorted = [...cards].sort((a, b) =>
            getCardValue(a, trumpSuit, level) - getCardValue(b, trumpSuit, level)
        );

        // 检查是否都是对子
        const pairs = [];
        let allPairs = true;
        for (let i = 0; i < sorted.length; i += 2) {
            if (i + 1 < sorted.length && isCardPair(sorted[i], sorted[i+1], trumpSuit, level)) {
                pairs.push([sorted[i], sorted[i+1]]);
            } else {
                allPairs = false;
                break;
            }
        }

        if (allPairs) {
            // 检查连续性：相邻对子的value差必须为1
            let allConsecutive = true;
            for (let i = 0; i < pairs.length - 1; i++) {
                const val1 = getCardValue(pairs[i][0], trumpSuit, level);
                const val2 = getCardValue(pairs[i+1][0], trumpSuit, level);
                if (val2 - val1 !== 1) {
                    allConsecutive = false;
                    break;
                }
                // 副牌拖拉机还要求同花色（主牌拖拉机跨类型不需要同花色）
                const allTrump1 = pairs[i].every(c => isTrump(c, trumpSuit, level));
                const allTrump2 = pairs[i+1].every(c => isTrump(c, trumpSuit, level));
                if (!allTrump1 && !allTrump2) {
                    // 两对都是副牌，必须同花色
                    if (pairs[i][0].suit !== pairs[i+1][0].suit) {
                        allConsecutive = false;
                        break;
                    }
                }
            }
            if (allConsecutive) {
                return { type: 'tractor', length: cards.length };
            }
            // 全是对子但不连续 → 检查是否是甩牌
            if (isThrowValid(cards, trumpSuit, level, playedCardsHistory)) {
                return { type: 'throw', length: cards.length };
            }
            return { type: 'invalid', length: cards.length };
        }
    }

    // 不是对子也不是拖拉机，检查是否是甩牌
    if (isThrowValid(cards, trumpSuit, level, playedCardsHistory)) {
        return { type: 'throw', length: cards.length };
    }

    return { type: 'invalid', length: cards.length };
}

/**
 * 验证甩牌合法性
 *
 * 修正后甩牌条件：
 *   1. 所有牌必须是同一门花色（不能混合花色，可主牌，也可副牌）
 *   2. 甩牌而出的任意一张牌，都是市面上该门花色中剩余最大的
 *      ——即比其中任何一张大的同花色牌，要么已经出过，要么也在本次甩出的牌里
 *
 * 主牌甩牌：所有牌都是主牌（大小王、级牌、主花色牌），比每张大的主牌都已出过或在甩牌中
 * 副牌甩牌：所有牌都是同一门副牌，比每张大的同花色牌都已出过或在甩牌中
 *
 * @param {Array} cards - 要甩的牌
 * @param {string|null} trumpSuit - 主花色
 * @param {string} level - 当前级别
 * @param {Array} playedCardsHistory - 本局所有已出过的牌
 * @returns {boolean}
 */
function isThrowValid(cards, trumpSuit, level, playedCardsHistory) {
    if (!cards || cards.length < 2) return false;
    if (!playedCardsHistory) playedCardsHistory = [];

    // 1. 判断是主牌甩牌还是副牌甩牌
    const firstIsTrump = isTrump(cards[0], trumpSuit, level);

    if (firstIsTrump) {
        // 主牌甩牌：所有牌必须都是主牌
        for (const card of cards) {
            if (!isTrump(card, trumpSuit, level)) return false;
        }

        // 构建所有主牌的候选列表（两副牌中的主牌）
        const allTrumpCandidates = [];
        // 主花色普通牌（排除级牌，级牌单独处理）
        if (trumpSuit) {
            for (const rank of RANKS) {
                if (rank === level) continue;
                for (let di = 0; di < 2; di++) {
                    allTrumpCandidates.push({ suit: trumpSuit, rank, isJoker: false, deckIndex: di });
                }
            }
        }
        // 所有级牌（非主花色的级牌 + 主花色的级牌）
        for (let di = 0; di < 2; di++) {
            for (const suit of [SUITS.SPADES, SUITS.HEARTS, SUITS.CLUBS, SUITS.DIAMONDS]) {
                allTrumpCandidates.push({ suit, rank: level, isJoker: false, deckIndex: di });
            }
        }
        // 大小王
        for (const jokerRank of JOKER_RANKS) {
            for (let di = 0; di < 2; di++) {
                allTrumpCandidates.push({ suit: SUITS.JOKER, rank: jokerRank, isJoker: true, deckIndex: di });
            }
        }

        // 标记已出过的主牌
        const playedSet = new Set();
        for (const card of playedCardsHistory) {
            if (isTrump(card, trumpSuit, level)) {
                playedSet.add(`${card.isJoker ? 'joker' : card.suit}-${card.rank}-${card.deckIndex}`);
            }
        }

        // 标记正在甩的牌
        const throwSet = new Set();
        for (const card of cards) {
            throwSet.add(`${card.isJoker ? 'joker' : card.suit}-${card.rank}-${card.deckIndex}`);
        }

        // 检查每张甩牌：比它大的主牌是否都已出过或在甩牌中
        for (const card of cards) {
            const cardValue = getCardValue(card, trumpSuit, level);
            for (const candidate of allTrumpCandidates) {
                const candidateValue = getCardValue(candidate, trumpSuit, level);
                if (candidateValue <= cardValue) continue;

                const candidateKey = `${candidate.isJoker ? 'joker' : candidate.suit}-${candidate.rank}-${candidate.deckIndex}`;
                if (!playedSet.has(candidateKey) && !throwSet.has(candidateKey)) {
                    return false;
                }
            }
        }
        return true;
    }

    // 副牌甩牌：所有牌必须是同一门副牌（非主牌）
    const suit = cards[0].suit;
    for (const card of cards) {
        if (isTrump(card, trumpSuit, level)) return false; // 不能是主牌
        if (card.suit !== suit) return false; // 必须同花色
    }

    // 2. 检查这些牌是否都是该门副牌中剩余最大的
    const allCardsOfSuit = [];
    for (const rank of RANKS) {
        if (rank === level) continue; // 级牌是主牌，不算副牌
        for (let deckIndex = 0; deckIndex < 2; deckIndex++) {
            allCardsOfSuit.push({ suit, rank, deckIndex });
        }
    }

    // 标记已出过的牌
    const playedSet = new Set();
    for (const card of playedCardsHistory) {
        if (!card.isJoker && card.suit === suit && card.rank !== level) {
            playedSet.add(`${card.suit}-${card.rank}-${card.deckIndex}`);
        }
    }

    // 标记正在甩的牌
    const throwSet = new Set();
    for (const card of cards) {
        throwSet.add(`${card.suit}-${card.rank}-${card.deckIndex}`);
    }

    // 对于每张正在甩的牌，检查比它大的牌是否都已出过或在自己手中（即也在甩牌中）
    for (const card of cards) {
        const cardValue = getCardValue(card, trumpSuit, level);
        for (const candidate of allCardsOfSuit) {
            const candidateCard = { suit: candidate.suit, rank: candidate.rank, isJoker: false, deckIndex: candidate.deckIndex };
            const candidateValue = getCardValue(candidateCard, trumpSuit, level);
            if (candidateValue <= cardValue) continue;

            const candidateKey = `${candidate.suit}-${candidate.rank}-${candidate.deckIndex}`;
            if (!playedSet.has(candidateKey) && !throwSet.has(candidateKey)) {
                return false;
            }
        }
    }

    return true;
}

/**
 * 统计一组牌中的对子数量
 */
function countPairsInCards(cards, trumpSuit, level) {
    const pairs = findPairsInCards(cards, trumpSuit, level);
    return pairs.length;
}

/**
 * 判断两张牌是否构成对子（同花色同点数不同副牌，或同等级的王）
 */
function isCardPair(card1, card2, trumpSuit, level) {
    // 大小王对
    if (card1.isJoker && card2.isJoker) {
        return card1.rank === card2.rank && card1.deckIndex !== card2.deckIndex;
    }
    // 普通牌对子
    if (!card1.isJoker && !card2.isJoker) {
        return card1.rank === card2.rank &&
               card1.suit === card2.suit &&
               card1.deckIndex !== card2.deckIndex;
    }
    return false;
}

/**
 * 检查出牌是否合法
 * @param {Array} playerCards - 玩家手牌
 * @param {Array} playedCards - 要出的牌
 * @param {Array} trickCards - 当前轮已出的牌
 * @param {string|null} trumpSuit - 主花色
 * @param {string} level - 当前级别
 * @param {Array} playedCardsHistory - 本局所有已出过的牌（供甩牌验证）
 */
function isValidPlay(playerCards, playedCards, trickCards, trumpSuit, level, playedCardsHistory) {
    if (playedCards.length === 0) return false;

    // 首家出牌
    if (trickCards.length === 0) {
        const pattern = getCardPattern(playedCards, trumpSuit, level, playedCardsHistory);
        return pattern.type !== 'invalid';
    }

    // 非首家，需要跟牌
    const leadCards = trickCards[0].cards;
    const leadPattern = getCardPattern(leadCards, trumpSuit, level, playedCardsHistory);
    const leadSuit = getLeadSuit(leadCards, trumpSuit, level);

    // 出牌数量必须和首家一致（不要求牌型一致——没对子时可以出单牌跟对子）
    if (playedCards.length !== leadPattern.length) {
        return false;
    }

    // 首家出的是主牌 → 所有人必须跟主牌
    if (leadSuit === null) {
        const playerTrumps = playerCards.filter(c => isTrump(c, trumpSuit, level));
        const playedTrump = playedCards.filter(c => isTrump(c, trumpSuit, level));
        const neededCount = Math.min(playerTrumps.length, leadPattern.length);
        if (playedTrump.length < neededCount) {
            return false;
        }
        // 主牌对子跟牌：有对子必须跟对子
        if (leadPattern.type === 'pair' && playerTrumps.length >= 2) {
            const playerPairs = findPairsInCards(playerTrumps, trumpSuit, level);
            if (playerPairs.length > 0) {
                const playedPairs = findPairsInCards(playedTrump, trumpSuit, level);
                if (playedPairs.length === 0 && playedTrump.length >= 2) {
                    return false;
                }
            }
        }
        // 主牌拖拉机跟牌：拖拉机→2对子→1对子→全单牌
        if (leadPattern.type === 'tractor' && playerTrumps.length >= leadPattern.length) {
            const playerPairs = findPairsInCards(playerTrumps, trumpSuit, level);
            const playerTractors = findTractorsInCards(playerTrumps, trumpSuit, level);
            const playedPairs = findPairsInCards(playedTrump, trumpSuit, level);
            const playedTractors = findTractorsInCards(playedTrump, trumpSuit, level);

            if (playerTractors.length > 0 && playedTractors.length === 0) {
                return false;
            }
            // 修正：没拖拉机但有2+对子，必须至少出2个对子
            if (playerTractors.length === 0 && playerPairs.length >= 2 && playedPairs.length < 2) {
                return false;
            }
            if (playerTractors.length === 0 && playerPairs.length === 1 && playedPairs.length === 0 &&
                playedTrump.length >= leadPattern.length) {
                return false;
            }
        }
        return true;
    }

    // 首家出的是副牌 → 检查是否有该花色
    const leadSuitNonTrump = playerCards.filter(c =>
        !c.isJoker && c.suit === leadSuit && !isTrump(c, trumpSuit, level)
    );

    if (leadSuitNonTrump.length > 0) {
        // 有首家花色，必须跟（不断门不能用主牌杀，必须跟同样花色）
        const playedLeadSuit = playedCards.filter(c =>
            !c.isJoker && c.suit === leadSuit && !isTrump(c, trumpSuit, level)
        );
        const neededCount = Math.min(leadSuitNonTrump.length, leadPattern.length);
        if (playedLeadSuit.length < neededCount) {
            return false;
        }

        // 对子跟牌：有对子必须出对子，没对子可以出单牌（2张单牌跟对子是合法的）
        if (leadPattern.type === 'pair' && leadSuitNonTrump.length >= 2) {
            const playerPairs = findPairsInCards(leadSuitNonTrump, trumpSuit, level);
            if (playerPairs.length > 0) {
                const playedPairs = findPairsInCards(playedLeadSuit, trumpSuit, level);
                if (playedPairs.length === 0 && playedLeadSuit.length >= 2) {
                    return false;
                }
            }
        }

        // 拖拉机跟牌规则：拖拉机→2对子→1对子+单牌→全单牌
        if (leadPattern.type === 'tractor' && leadSuitNonTrump.length >= leadPattern.length) {
            const playerPairs = findPairsInCards(leadSuitNonTrump, trumpSuit, level);
            const playerTractors = findTractorsInCards(leadSuitNonTrump, trumpSuit, level);
            const playedPairs = findPairsInCards(playedLeadSuit, trumpSuit, level);
            const playedTractors = findTractorsInCards(playedLeadSuit, trumpSuit, level);

            // 有拖拉机必须出拖拉机
            if (playerTractors.length > 0 && playedTractors.length === 0) {
                return false;
            }
            // 修正：没拖拉机但有2+对子，必须至少出2个对子
            if (playerTractors.length === 0 && playerPairs.length >= 2 && playedPairs.length < 2) {
                return false;
            }
            // 只有1个对子，也必须出
            if (playerTractors.length === 0 && playerPairs.length === 1 && playedPairs.length === 0 &&
                playedLeadSuit.length >= leadPattern.length) {
                // 出的牌数足够但没出对子 → 不合法
                return false;
            }
        }

        // 甩牌跟牌规则：跟同样张数的本门牌即可，不要求牌型一致
        // （甩牌本身就不规则，跟牌也不需要规则化）
        if (leadPattern.type === 'throw') {
            // 只要求张数一致 + 有该花色的牌都出了
            // 不需要检查对子等结构
        }

        return true;
    }

    // === 没有首家花色（断门）→ 可以垫牌或用主牌杀（杀必须同型）===
    // 断门后任何牌都可以垫，结构不匹配的主牌虽然不能"杀"（赢不了），
    // 但仍然是合法出牌（垫牌）。getTrickWinner 中会正确处理：
    // 牌型不匹配的跟牌会被跳过，不会错误地判赢。
    // 注意：不能用2张散主牌"冒充"对子杀牌，但这是 getTrickWinner 的职责，
    // 不是 isValidPlay 的职责——这里只负责判断出牌是否合法，不判断能否赢。
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
            if (isCardPair(cards[i], cards[j], trumpSuit, level)) {
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
 * 在给定牌中查找拖拉机（连对）
 * 返回拖拉机数组，每个拖拉机是展平的牌数组
 */
function findTractorsInCards(cards, trumpSuit, level) {
    const pairs = findPairsInCards(cards, trumpSuit, level);
    if (pairs.length < 2) return [];

    // 按value排序
    pairs.sort((a, b) =>
        getCardValue(a[0], trumpSuit, level) - getCardValue(b[0], trumpSuit, level)
    );

    const tractors = [];
    for (let i = 0; i < pairs.length - 1; i++) {
        const val1 = getCardValue(pairs[i][0], trumpSuit, level);
        const val2 = getCardValue(pairs[i+1][0], trumpSuit, level);
        if (val2 - val1 === 1) {
            // 检查副牌拖拉机需要同花色，主牌拖拉机不需要
            const allTrump1 = pairs[i].every(c => isTrump(c, trumpSuit, level));
            const allTrump2 = pairs[i+1].every(c => isTrump(c, trumpSuit, level));
            if (allTrump1 || allTrump2 || pairs[i][0].suit === pairs[i+1][0].suit) {
                tractors.push([...pairs[i], ...pairs[i+1]]);
            }
        }
    }
    return tractors;
}

/**
 * 分析一组牌的结构（拖拉机、对子、单张）
 * 修正后用于甩牌毙杀条件判断：需匹配对子数和拖拉机数
 *
 * @returns { tractors: Array, pairs: Array, singles: Array }
 *   tractors: 拖拉机数组，每个是展平的牌数组
 *   pairs: 对子数组，每个是两张牌
 *   singles: 单张数组
 */
function analyzeCardStructure(cards, trumpSuit, level) {
    const used = new Set();
    const tractors = [];
    const pairs = [];

    // 先找所有对子
    const allPairs = findPairsInCards(cards, trumpSuit, level);

    // 有2对以上时，检查相邻对子是否能组成拖拉机
    if (allPairs.length >= 2) {
        allPairs.sort((a, b) =>
            getCardValue(a[0], trumpSuit, level) - getCardValue(b[0], trumpSuit, level)
        );
        const pairUsed = new Set();
        for (let i = 0; i < allPairs.length - 1; i++) {
            if (pairUsed.has(i)) continue;
            const val1 = getCardValue(allPairs[i][0], trumpSuit, level);
            const val2 = getCardValue(allPairs[i + 1][0], trumpSuit, level);
            if (val2 - val1 === 1) {
                const allTrump1 = allPairs[i].every(c => isTrump(c, trumpSuit, level));
                const allTrump2 = allPairs[i + 1].every(c => isTrump(c, trumpSuit, level));
                if (allTrump1 || allTrump2 || allPairs[i][0].suit === allPairs[i + 1][0].suit) {
                    tractors.push([...allPairs[i], ...allPairs[i + 1]]);
                    pairUsed.add(i);
                    pairUsed.add(i + 1);
                }
            }
        }
        // 标记拖拉机用过的牌
        for (const t of tractors) {
            for (const c of t) used.add(c.id);
        }
    }

    // 添加所有未被拖拉机使用的对子（包括只有1对的情况）
    for (const pair of allPairs) {
        if (!used.has(pair[0].id) && !used.has(pair[1].id)) {
            pairs.push(pair);
            used.add(pair[0].id);
            used.add(pair[1].id);
        }
    }

    // 剩余的是单张
    const singles = cards.filter(c => !used.has(c.id));

    return { tractors, pairs, singles };
}

/**
 * 获取甩牌毙杀的强度分数（用于多方毙杀时比较）
 * 比较规则：拖拉机 > 对子 > 单牌，同类型比value
 * 返回排序后的强度数组，逐元素比较
 */
function getThrowKillStrength(cards, trumpSuit, level) {
    const struct = analyzeCardStructure(cards, trumpSuit, level);
    const strengths = [];

    // 拖拉机：基础分10000 + 拖拉机最大牌的value
    for (const t of struct.tractors) {
        const maxVal = Math.max(...t.map(c => getCardValue(c, trumpSuit, level)));
        strengths.push(10000 + maxVal);
    }
    // 对子：基础分5000 + 对子的value
    for (const p of struct.pairs) {
        strengths.push(5000 + getCardValue(p[0], trumpSuit, level));
    }
    // 单张：基础分0 + value
    for (const s of struct.singles) {
        strengths.push(getCardValue(s, trumpSuit, level));
    }

    // 降序排列
    strengths.sort((a, b) => b - a);
    return strengths;
}

/**
 * 比较两组牌的毙杀强度
 * @returns {number} 1: cards1强, -1: cards2强, 0: 相等
 */
function compareKillStrength(cards1, cards2, trumpSuit, level) {
    const s1 = getThrowKillStrength(cards1, trumpSuit, level);
    const s2 = getThrowKillStrength(cards2, trumpSuit, level);
    const len = Math.max(s1.length, s2.length);
    for (let i = 0; i < len; i++) {
        const v1 = s1[i] || 0;
        const v2 = s2[i] || 0;
        if (v1 > v2) return 1;
        if (v1 < v2) return -1;
    }
    return 0;
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
 *
 * 修正后甩牌的特殊处理：
 *   - 甩牌可以是主牌或副牌，都是该门花色中剩余最大的牌
 *   - 杀甩牌条件：全主牌 + 张数相同 + 对子数/拖拉机数 ≥ 甩牌中的对子数/拖拉机数
 *   - 多方毙杀时，比最强势牌的大小（拖拉机>对子>单牌），再比value
 *   - 混合主副牌（非全主）不算杀，不能赢甩牌
 */
function getTrickWinner(trickCards, trumpSuit, level, playedCardsHistory) {
    if (trickCards.length === 0) return null;
    
    const leadCards = trickCards[0].cards;
    const leadSuit = getLeadSuit(leadCards, trumpSuit, level);
    const leadPattern = getCardPattern(leadCards, trumpSuit, level, playedCardsHistory);
    
    // === 甩牌的特殊处理 ===
    if (leadPattern.type === 'throw') {
        // 甩牌的首家默认赢
        let winner = trickCards[0];
        let winnerIsKill = false; // 当前赢家是否是毙杀（全主牌）
        const leadStruct = analyzeCardStructure(leadCards, trumpSuit, level);
        const leadTractorCount = leadStruct.tractors.length;
        const leadPairCount = leadStruct.pairs.length;

        for (let i = 1; i < trickCards.length; i++) {
            const cards = trickCards[i].cards;
            const allTrump = cards.every(c => isTrump(c, trumpSuit, level));
            
            if (allTrump) {
                // 全主牌：检查拖拉机数和对子数是否足够杀甩牌
                const killStruct = analyzeCardStructure(cards, trumpSuit, level);
                const killTractorCount = killStruct.tractors.length;
                const killPairCount = killStruct.pairs.length;

                // 毙杀条件：拖拉机数≥甩牌拖拉机数 且 对子数≥甩牌对子数
                if (killTractorCount >= leadTractorCount && killPairCount >= leadPairCount) {
                    if (!winnerIsKill) {
                        // 之前是甩牌方（非毙杀），现在毙杀方直接赢
                        winner = trickCards[i];
                        winnerIsKill = true;
                    } else {
                        // 之前也是毙杀，比较毙杀强度（拖拉机>对子>单牌，再比value）
                        if (compareKillStrength(cards, winner.cards, trumpSuit, level) > 0) {
                            winner = trickCards[i];
                        }
                    }
                }
                // 拖拉机/对子数不够，不能杀，不改变赢家
            }
            // 非全主牌（垫牌或同花色小牌）永远不能赢甩牌
        }
        return winner;
    }
    
    // === 非甩牌的常规处理 ===
    let winner = trickCards[0];
    let maxValue = getCardValue(leadCards[0], trumpSuit, level);
    let winnerIsTrump = isTrump(leadCards[0], trumpSuit, level);
    // 记录当前赢家的花色（用于判断跟牌方是否在垫牌）
    // 垫牌（不同花色非主牌）永远不能赢，先出为大
    let winnerSuit = winnerIsTrump ? null : leadCards[0].suit;
    
    for (let i = 1; i < trickCards.length; i++) {
        const cards = trickCards[i].cards;
        
        // 修复：首家出对子/拖拉机时，跟牌方必须同型才能赢。
        // 跟牌方没对子时可以垫两张散牌跟对子（合法），但散牌永远赢不了对子；
        // 同理对子赢不了拖拉机，散牌赢不了拖拉机。
        // 之前只比较 cards[0] 的 value，会导致散牌中较大的牌（如A）
        // 错误地"赢"了对子。
        if (leadPattern.type === 'pair' || leadPattern.type === 'tractor') {
            const followerPattern = getCardPattern(cards, trumpSuit, level, playedCardsHistory);
            if (followerPattern.type !== leadPattern.type) {
                continue; // 牌型不一致（散牌/混合垫牌/低一级牌型），不能赢
            }
        }
        
        const card = cards[0]; // 同型时比较第一张即可
        const cardIsTrump = isTrump(card, trumpSuit, level);
        const cardValue = getCardValue(card, trumpSuit, level);
        
        // 如果之前不是主牌，现在是主牌，则现在的大（主牌杀副牌，同型前提已保证）
        if (!winnerIsTrump && cardIsTrump) {
            winner = trickCards[i];
            maxValue = cardValue;
            winnerIsTrump = true;
            winnerSuit = null;
            continue;
        }
        
        // 如果之前是主牌，现在不是，则跳过
        if (winnerIsTrump && !cardIsTrump) {
            continue;
        }
        
        // 同为主牌：比较大小
        if (winnerIsTrump && cardIsTrump) {
            if (cardValue > maxValue) {
                winner = trickCards[i];
                maxValue = cardValue;
            }
            continue;
        }
        
        // 同为副牌：必须跟首家花色才能赢，垫牌（不同花色）永远不能赢
        // 先出为大：同花色才比点数，不同花色是垫牌直接跳过
        if (!winnerIsTrump && !cardIsTrump) {
            // 垫牌（不同花色非主牌）不能赢，先出为大
            if (card.suit !== winnerSuit) {
                continue;
            }
            // 同花色才比较点数大小
            if (cardValue > maxValue) {
                winner = trickCards[i];
                maxValue = cardValue;
                winnerSuit = card.suit;
            }
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
 *
 * 注意：分数牌只有5(5分)、10(10分)、K(10分)，两副牌总分200分。
 * 所有分数都是5的倍数。通常只计算闲家方得分。
 *
 * 庄家方（守擂成功，闲家得分 < 80）：
 *   0分      → 升3级
 *   5-35分   → 升2级
 *   40-75分  → 升1级
 *   （76-79分在实际中不会出现，因为分数都是5的倍数）
 *
 * 闲家方（上台，闲家得分 ≥ 80）：
 *   80-119分  → 仅获得庄家身份，不升级
 *   120-159分 → 升1级（每比80多40分多升1级）
 *   160-199分 → 升2级
 *   200-239分 → 升3级
 *   240-279分 → 升4级
 *   ……以此类推
 *
 * 公式：score >= 80 时，upgrade = max(0, floor((score - 80) / 40))
 * 即80分只是上台门槛，每比80多出40分才开始多升1级。
 */
function calculateUpgrade(score, isDealerTeam) {
    if (isDealerTeam) {
        // 庄家方守擂成功（闲家得分 < 80）
        if (score === 0) return 3;
        if (score <= 35) return 2;
        if (score <= 75) return 1;
        return 0; // 76-79分：守擂成功但不升级
    } else {
        // 闲家上台（闲家得分 >= 80）
        // 80-119仅获得庄家身份不升级，每比80多40分多升1级
        return Math.max(0, Math.floor((score - 80) / 40));
    }
}

/**
 * 获取下一个级别（含必打规则）
 *
 * 必打级别：5、10、K、A
 * 无论通过守擂升级还是闲家抓分跳级，只要升级跨越这些级别，
 * 都必须忽略跳级的额外部分，落在这个必打级别上。
 * 打A时须守擂成功一次才算全局获胜。
 */
function getNextLevel(currentLevel, upgrade) {
    const levels = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const mustPlayLevels = ['5', '10', 'K', 'A']; // 必打级别
    const idx = levels.indexOf(currentLevel);
    let newIdx = Math.min(idx + upgrade, levels.length - 1);

    // 必打规则：如果升级跨越了必打级别，落在该级别上
    for (let i = idx + 1; i <= newIdx; i++) {
        if (mustPlayLevels.includes(levels[i])) {
            newIdx = i; // 落在遇到的第一个必打级别
            break;
        }
    }

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
        this.lastTrickInfo = null; // 最后一轮的牌型信息（供抠底倍数计算）
        this.playedCardsHistory = []; // 本局所有已出过的牌（供甩牌验证）
        this.failedThrows = []; // 记录甩错的牌型（供AI避免再次甩错）
        
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
    
    /**
     * 验证甩牌并处理甩错惩罚
     * 修正：甩错要惩罚，收回甩牌重新出牌
     *   - 闲家甩错：闲家方减分（甩牌张数×10）
     *   - 庄家方甩错：闲家方加分（甩牌张数×10）
     *
     * @param {string} position - 出牌玩家
     * @param {Array} cards - 甩出的牌
     * @returns {Object} { valid: boolean, penalty: number, message: string }
     */
    validateThrow(position, cards) {
        // 单张不需要甩牌验证
        if (!cards || cards.length < 2) {
            return { valid: true, penalty: 0, message: '' };
        }

        const pattern = getCardPattern(cards, this.trumpSuit, this.level, this.playedCardsHistory);

        // 合法牌型（单张、对子、拖拉机）或合法甩牌，不需要惩罚
        if (pattern.type === 'single' || pattern.type === 'pair' ||
            pattern.type === 'tractor' || pattern.type === 'throw') {
            return { valid: true, penalty: 0, message: '' };
        }

        // pattern.type === 'invalid'：判断是否是甩牌尝试
        // 甩牌尝试 = 2+张同花色副牌 或 2+张全主牌（但不是合法对子/拖拉机）
        const allTrump = cards.every(c => isTrump(c, this.trumpSuit, this.level));
        let isThrowAttempt = false;
        if (allTrump) {
            isThrowAttempt = true;
        } else {
            const allNonTrump = cards.every(c => !isTrump(c, this.trumpSuit, this.level));
            if (allNonTrump) {
                const suit = cards[0].suit;
                isThrowAttempt = cards.every(c => c.suit === suit);
            }
        }

        // 不是甩牌尝试（混合花色等），不作为甩错处理
        if (!isThrowAttempt) {
            return { valid: true, penalty: 0, message: '' };
        }

        // 甩错！计算惩罚
        const penalty = cards.length * 10;
        const isDealerTeam = TEAMS.TEAM_A.includes(this.dealer) === TEAMS.TEAM_A.includes(position);
        const dealerTeamKey = TEAMS.TEAM_A.includes(this.dealer) ? 'teamA' : 'teamB';
        const attackerTeamKey = dealerTeamKey === 'teamA' ? 'teamB' : 'teamA';

        if (isDealerTeam) {
            // 庄家方甩错 → 闲家加分
            this.trickScores[attackerTeamKey] += penalty;
        } else {
            // 闲家甩错 → 闲家减分（不低于0）
            this.trickScores[attackerTeamKey] = Math.max(0, this.trickScores[attackerTeamKey] - penalty);
        }

        // 记录甩错的牌型（供AI避免再次甩错）
        const failKey = cards.map(c => `${c.suit}-${c.rank}`).sort().join(',');
        this.failedThrows.push({ player: position, key: failKey, cards: cards.map(c => c.id) });

        return {
            valid: false,
            penalty: penalty,
            message: `甩牌不合法！${isDealerTeam ? '庄家方' : '闲家方'}甩错，${isDealerTeam ? '闲家加分' : '闲家减分'}${penalty}分`
        };
    }
    
    endTrick() {
        const winner = getTrickWinner(this.currentTrick, this.trumpSuit, this.level, this.playedCardsHistory);
        const score = getCardScore(this.currentTrick.flatMap(t => t.cards));
        
        // 保存最后一轮的牌型信息，供 endRound 计算抠底倍数
        const leadCards = this.currentTrick[0].cards;
        const leadPattern = getCardPattern(leadCards, this.trumpSuit, this.level);
        this.lastTrickInfo = {
            winner: winner.player,
            leadPattern: leadPattern,
            cards: this.currentTrick.flatMap(t => t.cards)
        };

        // 记录所有出过的牌到历史（供甩牌验证使用）
        this.playedCardsHistory.push(...this.currentTrick.flatMap(t => t.cards));
        
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
        // 最后一轮赢家获得底牌分数（抠底）
        // 抠底倍数规则：
        //   - 最后一轮走单张 → 闲家赢则底牌分数×2
        //   - 最后一轮走对子 → 闲家赢则底牌分数×4
        //   - 最后一轮走拖拉机 → 闲家赢则底牌分数×8
        //   - 最后一轮走甩牌 → 闲家赢则底牌分数×(甩牌张数×2)
        //     例：成功甩出5张未被杀，抠底，翻10倍
        //   - 庄家方赢则底牌分数原样归还（无倍数）
        //
        // 总分 = 走牌累积得分 + 抠底翻倍得分
        const lastWinner = this.trickLeader;
        const isTeamA = TEAMS.TEAM_A.includes(lastWinner);
        const kittyScore = getCardScore(this.kitty);
        
        // 判断最后一轮的牌型决定抠底倍数
        let kittyMultiplier = 1;
        let kittyFinalScore = kittyScore;
        const dealerTeamIsTeamA = TEAMS.TEAM_A.includes(this.dealer);
        const attackerWon = isTeamA !== dealerTeamIsTeamA; // 闲家方获胜
        
        if (attackerWon && kittyScore > 0 && this.lastTrickInfo) {
            const pattern = this.lastTrickInfo.leadPattern;
            if (pattern.type === 'tractor') {
                kittyMultiplier = 8;
            } else if (pattern.type === 'pair') {
                kittyMultiplier = 4;
            } else if (pattern.type === 'throw') {
                // 甩牌抠底：翻 (甩牌张数 × 2) 倍
                // 例：成功甩出5张未被杀，抠底，翻10倍
                kittyMultiplier = pattern.length * 2;
            } else {
                kittyMultiplier = 2;
            }
            kittyFinalScore = kittyScore * kittyMultiplier;
        }
        
        if (isTeamA) {
            this.trickScores.teamA += kittyFinalScore;
        } else {
            this.trickScores.teamB += kittyFinalScore;
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
            kittyMultiplier: kittyMultiplier,
            kittyFinalScore: kittyFinalScore,
            attackerWonLastTrick: attackerWon,
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
        this.lastRoundResult = result;
        return result;
    }
    
    checkGameOver(lastRoundResult) {
        // A必打规则：打A时须做庄守擂成功一次才算全局获胜
        // 只有庄家方在A级别且刚刚守擂成功（闲家得分<80），才算获胜
        if (lastRoundResult && lastRoundResult.winner) {
            const winnerTeam = lastRoundResult.winner;
            // 检查赢方是否是守擂成功的庄家方（非闲家上台）
            const dealerWon = lastRoundResult.attackerScore < 80;
            if (dealerWon && this.teamLevels[winnerTeam] === 'A') {
                return winnerTeam;
            }
        }
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
        this.lastTrickInfo = null;
        this.playedCardsHistory = [];
        this.failedThrows = [];
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
        findPairsInCards, findTractorsInCards, isCardPair,
        isThrowValid, countPairsInCards,
        analyzeCardStructure, getThrowKillStrength, compareKillStrength,
        BID_TYPES, BID_POWER,
        SUITS, RANKS, PLAYERS, TEAMS, SUIT_SYMBOLS
    };
}