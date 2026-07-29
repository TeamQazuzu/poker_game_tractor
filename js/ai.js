/**
 * 拖拉机 - AI逻辑
 * 智能AI：遵循规则、考虑角色（庄家/闲家）、配合队友、策略性出牌
 *
 * 核心策略：
 * 1. 庄家队首家：出副牌A或强力对子，期望队友跑分
 * 2. 闲家队首家：出小牌过渡，或出长套副牌消耗庄家主牌
 * 3. 跟牌：必须跟同花色，有对跟对；队友赢时跟小牌或贴分，对手赢时出大牌或杀主
 * 4. 分牌管理：5、10、K是分牌，队友赢时贴分，对手赢时保留
 */

class TractorAI {
    constructor(position) {
        this.position = position;
        this.reset();
    }

    reset() {
        this.memory = {
            playedCards: [],     // 已出过的牌
            suitVoid: {          // 记录各玩家断掉的花色
                left: new Set(),
                top: new Set(),
                right: new Set(),
                bottom: new Set()
            }
        };
    }

    /**
     * 判断是否是我方（和玩家 bottom 同队）
     */
    _isMyTeam() {
        return TEAMS.TEAM_A.includes(this.position);
    }

    /**
     * 判断是否是庄家队
     */
    _isDealerTeam(dealer) {
        return TEAMS.TEAM_A.includes(dealer) === this._isMyTeam();
    }

    /**
     * 判断某玩家是否是队友
     */
    _isTeammate(player) {
        if (player === this.position) return false;
        return TEAMS.TEAM_A.includes(player) === this._isMyTeam();
    }

    // ================================================================
    //  记忆系统
    // ================================================================

    /**
     * 记录出牌信息
     * @param {string} player - 出牌玩家
     * @param {Array} cards - 出的牌
     * @param {string} leadSuit - 首家花色
     * @param {string} trumpSuit - 主花色
     * @param {string} level - 级别
     */
    recordPlay(player, cards, leadSuit, trumpSuit, level) {
        // 记录已出的牌
        this.memory.playedCards.push(...cards);

        // 如果该玩家没有跟首家花色（出的是主牌或垫其他花色），记录该玩家断了该花色
        if (leadSuit !== null && player !== this.position) {
            const followedSuit = cards.some(c => !c.isJoker && c.suit === leadSuit && !isTrump(c, trumpSuit, level));
            if (!followedSuit) {
                this.memory.suitVoid[player].add(leadSuit);
            }
        }
    }

    /**
     * 判断某玩家是否已断某花色
     */
    _isPlayerVoid(player, suit) {
        return this.memory.suitVoid[player].has(suit);
    }

    /**
     * 统计某花色已出过的牌数
     */
    _countPlayedSuit(suit, trumpSuit, level) {
        return this.memory.playedCards.filter(c =>
            !c.isJoker && c.suit === suit && !isTrump(c, trumpSuit, level)
        ).length;
    }

    /**
     * 判断某张牌是否已经出过（用于判断某大牌是否还在场上）
     */
    _isCardPlayed(rank, suit) {
        return this.memory.playedCards.some(c => c.rank === rank && c.suit === suit);
    }

    /**
     * 判断某花色的A是否还在场上（没出过且自己手里没有）
     */
    _isAceStillOut(suit, hand, trumpSuit, level) {
        // 如果自己手里有A，当然还在
        if (hand.some(c => c.suit === suit && c.rank === 'A' && !isTrump(c, trumpSuit, level))) {
            return true;
        }
        // 检查是否已经出过（两副牌最多2张A）
        const playedCount = this.memory.playedCards.filter(c =>
            c.suit === suit && c.rank === 'A'
        ).length;
        return playedCount < 2;
    }

    // ================================================================
    //  叫主决策
    // ================================================================

    decideBid(hand, level, currentBid) {
        const suitStrength = {};
        for (const suit of [SUITS.SPADES, SUITS.HEARTS, SUITS.CLUBS, SUITS.DIAMONDS]) {
            const suitCards = hand.filter(c => c.suit === suit && !c.isJoker);
            const levelCards = suitCards.filter(c => c.rank === level);
            const trump2Cards = suitCards.filter(c => c.rank === '2');
            const highCards = suitCards.filter(c => ['A', 'K', 'Q', 'J'].includes(c.rank));
            let strength = 0;
            strength += levelCards.length * 10;
            strength += trump2Cards.length * 8;
            strength += highCards.length * 3;
            strength += suitCards.length * 1;
            if (levelCards.length >= 2) strength += 15;
            suitStrength[suit] = { strength, levelCards, totalCards: suitCards.length };
        }
        let bestSuit = null;
        let bestStrength = -1;
        for (const [suit, data] of Object.entries(suitStrength)) {
            if (data.levelCards.length >= 2 && data.strength > bestStrength) {
                bestStrength = data.strength;
                bestSuit = suit;
            }
        }
        if (!bestSuit && !currentBid) {
            for (const [suit, data] of Object.entries(suitStrength)) {
                if (data.strength > 20 && data.levelCards.length > 0 && data.strength > bestStrength) {
                    bestStrength = data.strength;
                    bestSuit = suit;
                }
            }
        }
        if (!bestSuit) return null;
        const bidCard = suitStrength[bestSuit].levelCards[0];
        return { suit: bestSuit, card: bidCard };
    }

    decideBidWithCounter(hand, level, currentBid) {
        const availableBids = getAvailableBids(hand, level, currentBid);
        if (availableBids.length === 0) return null;

        const suitStrength = {};
        for (const suit of [SUITS.SPADES, SUITS.HEARTS, SUITS.CLUBS, SUITS.DIAMONDS]) {
            const suitCards = hand.filter(c => c.suit === suit && !c.isJoker);
            const levelCards = suitCards.filter(c => c.rank === level);
            const highCards = suitCards.filter(c => ['A', 'K', 'Q', 'J'].includes(c.rank));
            let strength = 0;
            strength += levelCards.length * 10;
            strength += highCards.length * 3;
            strength += suitCards.length * 1;
            suitStrength[suit] = { strength, levelCards };
        }

        if (!currentBid) {
            let bestSuit = null;
            let bestStrength = 15;
            for (const [suit, data] of Object.entries(suitStrength)) {
                if (data.levelCards.length > 0 && data.strength > bestStrength) {
                    bestStrength = data.strength;
                    bestSuit = suit;
                }
            }
            if (bestSuit) {
                const bid = availableBids.find(b => b.type === BID_TYPES.SINGLE && b.suit === bestSuit);
                if (bid) return bid;
            }
        }

        const counterBids = availableBids.filter(b => canCounterBid(currentBid, b.type));
        if (counterBids.length === 0) return null;

        const handSize = hand.length;
        const trumpRelatedCount = hand.filter(c =>
            c.isJoker || c.rank === level || c.rank === '2'
        ).length;

        const shouldCounter = trumpRelatedCount >= 4 || handSize >= 20;
        if (!shouldCounter) return null;

        counterBids.sort((a, b) => b.power - a.power);
        return counterBids[0];
    }

    // ================================================================
    //  埋底决策
    // ================================================================

    decideBury(hand, trumpSuit, level) {
        // 策略：优先埋副牌短套中的小牌，保留主牌、分牌和长套
        const scored = hand.map(card => {
            const cardIsTrump = isTrump(card, trumpSuit, level);
            const value = getCardValue(card, trumpSuit, level);
            const isPoint = card.rank === '5' || card.rank === '10' || card.rank === 'K';

            let score = 0;
            if (cardIsTrump) {
                score = value + 200; // 主牌尽量不埋
            } else {
                score = value;
                if (isPoint) score += 50; // 分牌尽量不埋
            }
            return { card, score, isTrump: cardIsTrump };
        });

        scored.sort((a, b) => a.score - b.score);

        const toBury = [];
        for (const item of scored) {
            if (toBury.length >= 8) break;
            toBury.push(item.card);
        }
        return toBury;
    }

    // ================================================================
    //  出牌决策 - 入口
    // ================================================================

    decidePlay(hand, gameState, trickCards) {
        const { trumpSuit, level, dealer } = gameState;
        const isDealerTeam = this._isDealerTeam(dealer);

        if (trickCards.length === 0) {
            return this._leadPlay(hand, trumpSuit, level, isDealerTeam);
        }

        return this._followPlay(hand, trickCards, trumpSuit, level, isDealerTeam);
    }

    // ================================================================
    //  首家出牌策略
    // ================================================================

    _leadPlay(hand, trumpSuit, level, isDealerTeam) {
        const trumps = this._sortByValue(hand.filter(c => isTrump(c, trumpSuit, level)), trumpSuit, level);
        const nonTrumps = this._sortByValue(hand.filter(c => !isTrump(c, trumpSuit, level)), trumpSuit, level);

        // 按花色分组副牌
        const suitGroups = {};
        for (const suit of [SUITS.SPADES, SUITS.HEARTS, SUITS.CLUBS, SUITS.DIAMONDS]) {
            suitGroups[suit] = this._sortByValue(
                nonTrumps.filter(c => c.suit === suit), trumpSuit, level
            );
        }

        if (isDealerTeam) {
            return this._leadAsDealer(trumps, suitGroups, trumpSuit, level);
        } else {
            return this._leadAsAttacker(trumps, suitGroups, trumpSuit, level);
        }
    }

    /**
     * 庄家队首家出牌策略
     * 目标：出副牌A或强力对子，期望队友跑分
     * 关键：优先出短套A（该花色牌少，队友更容易用主牌杀或跟大牌跑分）
     */
    _leadAsDealer(trumps, suitGroups, trumpSuit, level) {
        // 1. 优先出副牌A单张（短套优先，让队友跑分更容易）
        const aCandidates = [];
        for (const suit of Object.keys(suitGroups)) {
            const aCard = suitGroups[suit].find(c => c.rank === 'A');
            if (aCard) {
                aCandidates.push({ card: aCard, suitLen: suitGroups[suit].length });
            }
        }
        if (aCandidates.length > 0) {
            // 优先出花色最短的A
            aCandidates.sort((a, b) => a.suitLen - b.suitLen);
            return [aCandidates[0].card];
        }

        // 2. 出副牌大对子（A对、K对、Q对）—— 强力控制
        for (const suit of Object.keys(suitGroups)) {
            const pairs = this._findPairs(suitGroups[suit], trumpSuit, level);
            for (const pair of pairs) {
                if (['A', 'K', 'Q'].includes(pair[0].rank)) {
                    return pair;
                }
            }
        }

        // 3. 出副牌拖拉机（连对）—— 大牌控制
        for (const suit of Object.keys(suitGroups)) {
            const tractor = this._findBestTractor(suitGroups[suit], trumpSuit, level);
            if (tractor && tractor.length >= 4) return tractor;
        }

        // 4. 出副牌K单张（有分10/K的对家可以贴分）
        for (const suit of Object.keys(suitGroups)) {
            const kCard = suitGroups[suit].find(c => c.rank === 'K');
            if (kCard) return [kCard];
        }

        // 5. 出副牌Q单张
        for (const suit of Object.keys(suitGroups)) {
            const qCard = suitGroups[suit].find(c => c.rank === 'Q');
            if (qCard) return [qCard];
        }

        // 6. 如果副牌都是小牌，出最长套的小牌（消耗对手主牌）
        let longestSuit = null;
        let longestLen = 0;
        for (const suit of Object.keys(suitGroups)) {
            if (suitGroups[suit].length > longestLen) {
                longestLen = suitGroups[suit].length;
                longestSuit = suit;
            }
        }
        if (longestSuit && longestLen > 0) {
            return [suitGroups[longestSuit][0]]; // 最小的
        }

        // 7. 没有副牌了，出主牌
        if (trumps.length >= 2) {
            // 主牌多，出主牌对子清主
            const trumpPairs = this._findPairs(trumps, trumpSuit, level);
            if (trumpPairs.length > 0) return trumpPairs[0];
        }
        if (trumps.length > 0) return [trumps[0]]; // 最小主牌

        // 8. 兜底
        for (const suit of Object.keys(suitGroups)) {
            if (suitGroups[suit].length > 0) return [suitGroups[suit][0]];
        }
        return [hand[0]];
    }

    /**
     * 闲家队首家出牌策略
     * 目标：出小牌过渡，或出长套消耗庄家主牌，伺机抢分
     * 关键：如果有A先出A抢分；否则出长套小牌消耗庄家主牌
     */
    _leadAsAttacker(trumps, suitGroups, trumpSuit, level) {
        // 1. 如果有副牌A，先出A抢分（短套优先）
        const aCandidates = [];
        for (const suit of Object.keys(suitGroups)) {
            const aCard = suitGroups[suit].find(c => c.rank === 'A');
            if (aCard) {
                aCandidates.push({ card: aCard, suitLen: suitGroups[suit].length });
            }
        }
        if (aCandidates.length > 0) {
            aCandidates.sort((a, b) => a.suitLen - b.suitLen);
            return [aCandidates[0].card];
        }

        // 2. 有大对子（K对、Q对）也可以出
        for (const suit of Object.keys(suitGroups)) {
            const pairs = this._findPairs(suitGroups[suit], trumpSuit, level);
            for (const pair of pairs) {
                if (['K', 'Q'].includes(pair[0].rank)) {
                    return pair;
                }
            }
        }

        // 3. 出最长副牌套的最小牌（消耗对手主牌）
        let longestSuit = null;
        let longestLen = 0;
        for (const suit of Object.keys(suitGroups)) {
            if (suitGroups[suit].length > longestLen) {
                longestLen = suitGroups[suit].length;
                longestSuit = suit;
            }
        }
        if (longestSuit && longestLen > 0) {
            return [suitGroups[longestSuit][0]]; // 最小的
        }

        // 4. 出任意副牌小牌
        for (const suit of Object.keys(suitGroups)) {
            if (suitGroups[suit].length > 0) {
                return [suitGroups[suit][0]]; // 最小的
            }
        }

        // 5. 全是主牌，出最小主牌
        if (trumps.length > 0) return [trumps[0]];
        return [hand[0]];
    }

    // ================================================================
    //  跟牌策略
    // ================================================================

    _followPlay(hand, trickCards, trumpSuit, level, isDealerTeam) {
        const leadCards = trickCards[0].cards;
        const leadPattern = getCardPattern(leadCards, trumpSuit, level);
        const leadSuit = getLeadSuit(leadCards, trumpSuit, level);

        // 判断当前谁在赢
        const currentWinner = getTrickWinner(trickCards, trumpSuit, level);
        const iAmWinning = currentWinner && this._isTeammate(currentWinner.player);

        const trumps = this._sortByValue(hand.filter(c => isTrump(c, trumpSuit, level)), trumpSuit, level);

        // 计算当前桌面上的分数
        const trickScore = getCardScore(trickCards.flatMap(t => t.cards));

        // 判断是否是最后一家（第4个出牌）
        const isLastPlayer = trickCards.length === 3;

        // === 首家出的是主牌 ===
        if (leadSuit === null) {
            return this._followTrump(trumps, hand, leadPattern, iAmWinning, trickScore, trumpSuit, level, trickCards, isLastPlayer);
        }

        // === 首家出的是副牌花色 ===
        const leadSuitCards = this._sortByValue(
            hand.filter(c => !c.isJoker && c.suit === leadSuit && !isTrump(c, trumpSuit, level)),
            trumpSuit, level
        );

        const hasLeadSuit = leadSuitCards.length > 0;

        if (hasLeadSuit) {
            return this._followSuit(leadSuitCards, leadPattern, iAmWinning, trickScore, trumpSuit, level, trickCards, hand, isDealerTeam, isLastPlayer, leadSuit);
        }

        // 没有首家花色 → 杀主或垫牌
        return this._followNoSuit(trumps, hand, leadPattern, trickCards, iAmWinning, trickScore, trumpSuit, level, isDealerTeam, isLastPlayer);
    }

    /**
     * 跟主牌
     */
    _followTrump(trumps, hand, leadPattern, iAmWinning, trickScore, trumpSuit, level, trickCards, isLastPlayer) {
        const needLen = leadPattern.length;

        // 主牌不够，尽量出主牌，不够的用副牌补
        if (trumps.length < needLen) {
            const result = [...trumps];
            const nonTrumps = this._sortByValue(
                hand.filter(c => !isTrump(c, trumpSuit, level)), trumpSuit, level
            );
            while (result.length < needLen) {
                if (iAmWinning) {
                    // 队友赢，垫最小的非分牌
                    const safe = nonTrumps.find(c => !this._isPointCard(c) && !result.some(r => r.id === c.id));
                    if (safe) {
                        result.push(safe);
                        nonTrumps.splice(nonTrumps.indexOf(safe), 1);
                    } else {
                        result.push(nonTrumps.shift() || hand[0]);
                    }
                } else {
                    // 对手赢，也垫小牌（主牌不够杀不了）
                    const safe = nonTrumps.find(c => !this._isPointCard(c) && !result.some(r => r.id === c.id));
                    if (safe) {
                        result.push(safe);
                        nonTrumps.splice(nonTrumps.indexOf(safe), 1);
                    } else {
                        result.push(nonTrumps.shift() || hand[0]);
                    }
                }
            }
            return result.slice(0, needLen);
        }

        if (leadPattern.type === 'single') {
            if (iAmWinning) {
                // 队友赢，出最小主牌
                return [trumps[0]];
            }
            // 对手赢，看能不能赢
            const winner = getTrickWinner(trickCards, trumpSuit, level);
            const winnerValue = getCardValue(winner.cards[0], trumpSuit, level);
            // 找最小的能赢的主牌
            for (const trump of trumps) {
                if (getCardValue(trump, trumpSuit, level) > winnerValue) {
                    return [trump];
                }
            }
            // 赢不了，出最小主牌
            return [trumps[0]];
        }

        if (leadPattern.type === 'pair') {
            const pairs = this._findPairs(trumps, trumpSuit, level);
            if (pairs.length > 0) {
                if (iAmWinning) {
                    // 队友赢，出最小主牌对子
                    return pairs[0];
                }
                // 对手赢，找最小的能赢的对子
                const winner = getTrickWinner(trickCards, trumpSuit, level);
                const winnerValue = getCardValue(winner.cards[0], trumpSuit, level);
                for (const pair of pairs) {
                    if (getCardValue(pair[0], trumpSuit, level) > winnerValue) {
                        return pair;
                    }
                }
                // 赢不了，出最小对子
                return pairs[0];
            }
            // 没有主牌对子，出最小的两张主牌
            return [trumps[0], trumps[1] || trumps[0]];
        }

        if (leadPattern.type === 'tractor') {
            const tractors = this._findTractors(trumps, trumpSuit, level);
            const matching = tractors.find(t => t.length >= needLen);
            if (matching) {
                if (iAmWinning) return matching.slice(0, needLen);
                // 对手赢，出最大拖拉机
                return matching.slice(0, needLen);
            }
            // 没有拖拉机，优先出对子
            const pairs = this._findPairs(trumps, trumpSuit, level);
            const result = [];
            for (const pair of pairs) {
                result.push(...pair);
                if (result.length >= needLen) break;
            }
            const used = new Set(result.map(c => c.id));
            const remaining = trumps.filter(c => !used.has(c.id));
            while (result.length < needLen && remaining.length > 0) {
                result.push(remaining.shift());
            }
            return result.slice(0, needLen);
        }

        return [trumps[0]];
    }

    /**
     * 跟副牌花色
     * 核心策略：
     * - 队友赢：跟最小非分牌；最后一家时贴分牌
     * - 对手赢：出最大的牌试图赢；赢不了跟最小非分牌
     * - 有对子必须跟对子；两对时保留大的跟小的
     */
    _followSuit(leadSuitCards, leadPattern, iAmWinning, trickScore, trumpSuit, level, trickCards, hand, isDealerTeam, isLastPlayer, leadSuit) {
        if (leadPattern.type === 'single') {
            return this._followSingle(leadSuitCards, iAmWinning, trickScore, trumpSuit, level, trickCards, isLastPlayer, leadSuit);
        }
        if (leadPattern.type === 'pair') {
            return this._followPair(leadSuitCards, iAmWinning, trickScore, trumpSuit, level, trickCards, isLastPlayer, leadSuit, hand);
        }
        if (leadPattern.type === 'tractor') {
            return this._followTractor(leadSuitCards, leadPattern.length, iAmWinning, trickScore, trumpSuit, level, trickCards, isLastPlayer, leadSuit);
        }
        return [leadSuitCards[0]];
    }

    /**
     * 跟单张副牌
     * 策略：
     * - 队友赢且非最后一家：跟最小的非分牌（保留分牌给队友大牌时贴）
     * - 队友赢且最后一家：贴分牌（帮队友加分）
     * - 对手赢：出最大的牌试图赢；赢不了跟最小非分牌
     */
    _followSingle(leadSuitCards, iAmWinning, trickScore, trumpSuit, level, trickCards, isLastPlayer, leadSuit) {
        if (iAmWinning) {
            if (isLastPlayer) {
                // 最后一家，队友赢，贴分牌
                const pointCards = leadSuitCards.filter(c => this._isPointCard(c));
                if (pointCards.length > 0) {
                    return [pointCards[pointCards.length - 1]]; // 最大的分牌
                }
            }
            // 非最后一家，队友赢，跟最小的非分牌
            const nonPoint = leadSuitCards.filter(c => !this._isPointCard(c));
            if (nonPoint.length > 0) return [nonPoint[0]];
            // 全是分牌，跟最小的
            return [leadSuitCards[0]];
        }

        // 对手赢
        // 先看能不能赢（同花色内比大小）
        const winner = getTrickWinner(trickCards, trumpSuit, level);
        const winnerCard = winner.cards[0];
        const winnerIsTrump = isTrump(winnerCard, trumpSuit, level);

        if (!winnerIsTrump) {
            // 当前赢家是副牌，看能不能用更大的同花色副牌赢
            const winnerValue = getCardValue(winnerCard, trumpSuit, level);
            for (let i = leadSuitCards.length - 1; i >= 0; i--) {
                if (getCardValue(leadSuitCards[i], trumpSuit, level) > winnerValue) {
                    // 能赢，出最小的能赢的牌
                    return [leadSuitCards[i]];
                }
            }
        }
        // 赢不了（对手杀主了或牌不够大），跟最小非分牌
        const nonPoint = leadSuitCards.filter(c => !this._isPointCard(c));
        if (nonPoint.length > 0) return [nonPoint[0]];
        return [leadSuitCards[0]];
    }

    /**
     * 跟对子副牌
     * 核心规则：
     * - 有对子必须跟对子（即使比首家小）
     * - 能杀（赢）则杀：出最小的能赢的对子
     * - 杀不了时：出最小的非分牌对子（保留分牌对子如对5、对10）
     * - 两对选择：优先保留分牌对子，而非简单留大出小
     *   例：一对8和一对5 → 出一对8，保留分牌一对5
     * - 队友赢时：看是否想要出牌权
     *   需要出牌权 → 出最大的对子杀队友（上手）
     *   不需要出牌权 → 出最小非分牌对子；最后一家贴分牌对子
     */
    _followPair(leadSuitCards, iAmWinning, trickScore, trumpSuit, level, trickCards, isLastPlayer, leadSuit, hand) {
        const pairs = this._findPairs(leadSuitCards, trumpSuit, level);

        if (pairs.length > 0) {
            // 分离分牌对子和非分牌对子
            const pointPairs = pairs.filter(p => p.some(c => this._isPointCard(c)));
            const nonPointPairs = pairs.filter(p => !p.some(c => this._isPointCard(c)));

            if (iAmWinning) {
                // === 队友在赢 ===
                if (isLastPlayer) {
                    // 最后一家，队友赢，贴最大的分牌对子
                    if (pointPairs.length > 0) {
                        return pointPairs[pointPairs.length - 1];
                    }
                    // 没有分牌对子，出最大的非分牌对子（帮队友消耗）
                    if (nonPointPairs.length > 0) {
                        return nonPointPairs[nonPointPairs.length - 1];
                    }
                    return pairs[pairs.length - 1];
                }

                // 非最后一家，队友赢
                // 判断是否想要出牌权（手上还有好牌想出，如还有A或大对子）
                const wantControl = this._wantControl(hand, trumpSuit, level, leadSuit);

                if (wantControl) {
                    // 想要出牌权 → 出最大的对子杀队友
                    // 但如果最大对子是分牌对子，要权衡：分牌对子留着贴分更有价值
                    if (nonPointPairs.length > 0) {
                        return nonPointPairs[nonPointPairs.length - 1]; // 最大非分牌对子
                    }
                    // 只有分牌对子，不出分牌去抢牌权（不划算）
                }

                // 不需要出牌权 → 出最小的非分牌对子（保留分牌对子）
                if (nonPointPairs.length > 0) return nonPointPairs[0];
                // 只有分牌对子，出最小的
                return pairs[0];
            }

            // === 对手在赢 ===
            // 先看能不能杀（同花色内比大小）
            const winner = getTrickWinner(trickCards, trumpSuit, level);
            const winnerCard = winner.cards[0];
            const winnerIsTrump = isTrump(winnerCard, trumpSuit, level);

            if (!winnerIsTrump) {
                // 当前赢家是副牌对子，找最小的能赢的对子
                const winnerValue = getCardValue(winnerCard, trumpSuit, level);
                // 优先用非分牌对子杀
                for (const pair of nonPointPairs) {
                    if (getCardValue(pair[0], trumpSuit, level) > winnerValue) {
                        return pair;
                    }
                }
                // 非分牌对子杀不了，看分牌对子能否杀
                for (const pair of pointPairs) {
                    if (getCardValue(pair[0], trumpSuit, level) > winnerValue) {
                        return pair;
                    }
                }
            }

            // 杀不了 → 出最小的非分牌对子（保留分牌对子）
            // 例：一对8和一对5 → 出一对8，保留分牌一对5
            if (nonPointPairs.length > 0) return nonPointPairs[0];
            // 只有分牌对子，出最小的
            return pairs[0];
        }

        // 没有对子，出两张牌
        if (iAmWinning) {
            if (isLastPlayer) {
                // 最后一家，队友赢，贴分牌
                const pointCards = leadSuitCards.filter(c => this._isPointCard(c));
                const nonPointCards = leadSuitCards.filter(c => !this._isPointCard(c));
                const result = [];
                // 先贴最大的分牌
                while (result.length < 2 && pointCards.length > 0) {
                    result.push(pointCards.pop());
                }
                // 不够用非分牌补
                while (result.length < 2 && nonPointCards.length > 0) {
                    result.push(nonPointCards.shift());
                }
                return result;
            }
            // 非最后一家，队友赢，出最小的两张非分牌
            const nonPoint = leadSuitCards.filter(c => !this._isPointCard(c));
            if (nonPoint.length >= 2) return [nonPoint[0], nonPoint[1]];
            if (nonPoint.length === 1) return [nonPoint[0], leadSuitCards[0]];
            return [leadSuitCards[0], leadSuitCards[1] || leadSuitCards[0]];
        }

        // 对手赢，出最大的两张（试图赢）
        const len = leadSuitCards.length;
        if (len >= 2) {
            return [leadSuitCards[len - 1], leadSuitCards[len - 2]];
        }
        return [leadSuitCards[0], leadSuitCards[0]];
    }

    /**
     * 跟拖拉机副牌
     * 策略类似对子跟牌，但需要跟拖拉机长度
     */
    _followTractor(leadSuitCards, needLen, iAmWinning, trickScore, trumpSuit, level, trickCards, isLastPlayer, leadSuit) {
        const tractors = this._findTractors(leadSuitCards, trumpSuit, level);
        const matching = tractors.find(t => t.length >= needLen);
        if (matching) {
            if (iAmWinning) return matching.slice(0, needLen);
            // 对手赢，出最大拖拉机
            return matching.slice(0, needLen);
        }

        // 没有拖拉机，尽量出对子
        const pairs = this._findPairs(leadSuitCards, trumpSuit, level);
        const neededPairs = needLen / 2;
        const result = [];

        if (iAmWinning) {
            if (isLastPlayer) {
                // 最后一家，队友赢，优先出分牌对子
                const pointPairs = pairs.filter(p => p.some(c => this._isPointCard(c)));
                const nonPointPairs = pairs.filter(p => !p.some(c => this._isPointCard(c)));
                // 先出分牌对子
                for (const pair of pointPairs) {
                    result.push(...pair);
                    if (result.length >= needLen) break;
                }
                // 不够用非分牌对子补
                for (const pair of nonPointPairs) {
                    if (result.length >= needLen) break;
                    result.push(...pair);
                }
            } else {
                // 非最后一家，队友赢，出最小的对子（非分牌优先）
                const nonPointPairs = pairs.filter(p => !p.some(c => this._isPointCard(c)));
                const sourcePairs = nonPointPairs.length >= neededPairs ? nonPointPairs : pairs;
                for (let i = 0; i < Math.min(neededPairs, sourcePairs.length); i++) {
                    result.push(...sourcePairs[i]);
                }
            }
        } else {
            // 对手赢，出最大的对子
            for (let i = 0; i < Math.min(neededPairs, pairs.length); i++) {
                result.push(...pairs[pairs.length - 1 - i]);
            }
        }

        // 不够的从剩余牌中补
        const used = new Set(result.map(c => c.id));
        const unused = leadSuitCards.filter(c => !used.has(c.id));
        while (result.length < needLen && unused.length > 0) {
            if (iAmWinning && !isLastPlayer) {
                result.push(unused.shift()); // 最小非分牌
            } else if (iAmWinning && isLastPlayer) {
                // 最后一家贴分牌
                const point = unused.find(c => this._isPointCard(c));
                if (point) {
                    result.push(point);
                    unused.splice(unused.indexOf(point), 1);
                } else {
                    result.push(unused.pop());
                }
            } else {
                result.push(unused.pop()); // 最大
            }
        }
        return result.slice(0, needLen);
    }

    /**
     * 没有首家花色：杀主或垫牌（断门处理）
     * 
     * 核心规则：
     * 1. 队友赢 → 垫牌（非分牌优先）；最后一家贴分牌
     * 2. 对手赢 + 有分在桌上 → 必须用主牌杀（优先用主牌分牌杀，既赢牌又拿分）
     *    除非没主牌了，只能垫副牌
     * 3. 对手赢 + 无分在桌上 → 50%概率杀主抢出牌权，50%概率垫副牌
     *    （概率分支让AI不可预测）
     * 
     * 杀主时的选牌：
     * - 优先用主牌分牌（主花色的5/10/K）杀，既赢牌又拿分
     * - 没有主牌分牌时，用最小的能赢的主牌
     */
    _followNoSuit(trumps, hand, leadPattern, trickCards, iAmWinning, trickScore, trumpSuit, level, isDealerTeam, isLastPlayer) {
        const nonTrumps = this._sortByValue(
            hand.filter(c => !isTrump(c, trumpSuit, level)), trumpSuit, level
        );
        const needLen = leadPattern.length;

        // === 队友在赢 → 垫牌 ===
        if (iAmWinning) {
            if (isLastPlayer) {
                // 最后一家，队友赢，贴分牌
                const pointCards = nonTrumps.filter(c => this._isPointCard(c));
                const safeCards = nonTrumps.filter(c => !this._isPointCard(c));
                const result = [];
                while (result.length < needLen && pointCards.length > 0) {
                    result.push(pointCards.pop());
                }
                while (result.length < needLen && safeCards.length > 0) {
                    result.push(safeCards.shift());
                }
                while (result.length < needLen && trumps.length > 0) {
                    result.push(trumps[0]);
                }
                return result.slice(0, needLen);
            }
            // 非最后一家，队友赢，垫最小的非分牌
            const safeCards = nonTrumps.filter(c => !this._isPointCard(c));
            if (safeCards.length >= needLen) {
                return safeCards.slice(0, needLen);
            }
            const result = [...safeCards];
            const pointCards = nonTrumps.filter(c => this._isPointCard(c));
            while (result.length < needLen && pointCards.length > 0) {
                result.push(pointCards.shift());
            }
            while (result.length < needLen && trumps.length > 0) {
                result.push(trumps[0]);
            }
            return result.slice(0, needLen);
        }

        // === 对手在赢 ===

        // 有分在桌上 → 必须杀（除非没主牌）
        if (trickScore > 0) {
            if (trumps.length >= needLen) {
                return this._killWithTrump(trumps, leadPattern, trickCards, trumpSuit, level, needLen);
            }
            // 没主牌了，只能垫牌（优先非分牌）
            return this._discardCards(nonTrumps, trumps, needLen);
        }

        // 无分在桌上 → 50%杀主 / 50%垫牌（概率分支）
        if (trumps.length >= needLen && nonTrumps.length >= needLen) {
            // 两种选择都可行，用50%概率决定
            if (Math.random() < 0.5) {
                // 杀主抢出牌权
                return this._killWithTrump(trumps, leadPattern, trickCards, trumpSuit, level, needLen);
            }
            // 垫副牌
            return this._discardCards(nonTrumps, trumps, needLen);
        }

        // 只有一种选择
        if (trumps.length >= needLen) {
            // 有主牌但没副牌 → 杀主
            return this._killWithTrump(trumps, leadPattern, trickCards, trumpSuit, level, needLen);
        }

        // 没主牌 → 只能垫副牌
        return this._discardCards(nonTrumps, trumps, needLen);
    }

    /**
     * 用主牌杀
     * 优先用主牌分牌（既赢牌又拿分），其次用最小的能赢的主牌
     */
    _killWithTrump(trumps, leadPattern, trickCards, trumpSuit, level, needLen) {
        if (leadPattern.type === 'single') {
            // 优先用主牌分牌杀（♠5、♠10、♠K等主花色分牌）
            const trumpPointCards = trumps.filter(c => this._isPointCard(c));
            if (trumpPointCards.length > 0) {
                // 找最小的能赢的主牌分牌
                const winner = getTrickWinner(trickCards, trumpSuit, level);
                const winnerCard = winner.cards[0];
                const winnerIsTrump = isTrump(winnerCard, trumpSuit, level);

                if (!winnerIsTrump) {
                    // 对手是副牌，任何主牌都能赢，用最小的主牌分牌
                    return [trumpPointCards[0]];
                }
                // 对手是主牌，找最小的能赢的主牌分牌
                const winnerValue = getCardValue(winnerCard, trumpSuit, level);
                for (const card of trumpPointCards) {
                    if (getCardValue(card, trumpSuit, level) > winnerValue) {
                        return [card];
                    }
                }
            }
            // 没有主牌分牌，用最小的能赢的主牌
            return [this._findMinWinningTrump(trumps, trickCards, trumpSuit, level, leadPattern)];
        }

        if (leadPattern.type === 'pair') {
            const pairs = this._findPairs(trumps, trumpSuit, level);
            // 优先用含分牌的对子
            const pointPairs = pairs.filter(p => p.some(c => this._isPointCard(c)));
            if (pointPairs.length > 0) {
                const winner = getTrickWinner(trickCards, trumpSuit, level);
                const winnerCard = winner.cards[0];
                const winnerIsTrump = isTrump(winnerCard, trumpSuit, level);
                if (!winnerIsTrump) return pointPairs[0];
                const winnerValue = getCardValue(winnerCard, trumpSuit, level);
                for (const pair of pointPairs) {
                    if (getCardValue(pair[0], trumpSuit, level) > winnerValue) return pair;
                }
            }
            if (pairs.length > 0) {
                return this._findMinWinningPair(pairs, trickCards, trumpSuit, level);
            }
            return [trumps[trumps.length - 1], trumps[trumps.length - 2] || trumps[trumps.length - 1]];
        }

        if (leadPattern.type === 'tractor') {
            const tractors = this._findTractors(trumps, trumpSuit, level);
            const matching = tractors.find(t => t.length >= needLen);
            if (matching) return matching.slice(0, needLen);
            const pairs = this._findPairs(trumps, trumpSuit, level);
            const result = [];
            for (const pair of pairs) {
                result.push(...pair);
                if (result.length >= needLen) break;
            }
            const used = new Set(result.map(c => c.id));
            const remaining = trumps.filter(c => !used.has(c.id));
            while (result.length < needLen && remaining.length > 0) {
                result.push(remaining.pop());
            }
            return result.slice(0, needLen);
        }

        return [trumps[0]];
    }

    /**
     * 垫牌（不杀主时）
     * 优先垫最小的非分牌，不够再垫分牌，最后垫主牌
     */
    _discardCards(nonTrumps, trumps, needLen) {
        const safeCards = nonTrumps.filter(c => !this._isPointCard(c));
        if (safeCards.length >= needLen) {
            return safeCards.slice(0, needLen);
        }
        const result = [...safeCards];
        const pointCards = nonTrumps.filter(c => this._isPointCard(c));
        while (result.length < needLen && pointCards.length > 0) {
            result.push(pointCards.shift());
        }
        while (result.length < needLen && trumps.length > 0) {
            result.push(trumps[0]);
        }
        return result.slice(0, needLen);
    }

    /**
     * 找最小的能赢过当前牌的主牌（单张）
     */
    _findMinWinningTrump(trumps, trickCards, trumpSuit, level, leadPattern) {
        const currentWinner = getTrickWinner(trickCards, trumpSuit, level);
        const winnerCard = currentWinner.cards[0];
        const winnerValue = getCardValue(winnerCard, trumpSuit, level);
        const winnerIsTrump = isTrump(winnerCard, trumpSuit, level);

        // 如果当前赢家不是主牌，任何主牌都能赢，出最小的
        if (!winnerIsTrump) return trumps[0];

        // 找最小的能赢的主牌
        for (const trump of trumps) {
            if (getCardValue(trump, trumpSuit, level) > winnerValue) {
                return trump;
            }
        }

        // 赢不了，出最小的
        return trumps[0];
    }

    /**
     * 找最小的能赢过当前牌的主牌对子
     */
    _findMinWinningPair(pairs, trickCards, trumpSuit, level) {
        const currentWinner = getTrickWinner(trickCards, trumpSuit, level);
        const winnerCard = currentWinner.cards[0];
        const winnerValue = getCardValue(winnerCard, trumpSuit, level);
        const winnerIsTrump = isTrump(winnerCard, trumpSuit, level);

        if (!winnerIsTrump) return pairs[0]; // 最小对子即可

        for (const pair of pairs) {
            if (getCardValue(pair[0], trumpSuit, level) > winnerValue) {
                return pair;
            }
        }
        return pairs[0]; // 赢不了，出最小
    }

    // ================================================================
    //  工具函数
    // ================================================================

    /**
     * 判断是否是分牌
     */
    _isPointCard(card) {
        return card.rank === '5' || card.rank === '10' || card.rank === 'K';
    }

    /**
     * 判断是否想要拿到出牌权
     * 条件：手上有强力牌可以出（如副牌A、大对子、拖拉机）
     * 或者手上有分牌需要队友帮忙跑分
     */
    _wantControl(hand, trumpSuit, level, currentLeadSuit) {
        if (!hand) return false;

        // 如果还有副牌A（非当前出牌花色），想要出牌权出A
        for (const suit of [SUITS.SPADES, SUITS.HEARTS, SUITS.CLUBS, SUITS.DIAMONDS]) {
            if (suit === currentLeadSuit) continue;
            const aCard = hand.find(c =>
                c.suit === suit && c.rank === 'A' && !isTrump(c, trumpSuit, level)
            );
            if (aCard) return true;
        }

        // 如果还有大对子（A对、K对），想要出牌权
        const nonTrumps = hand.filter(c => !isTrump(c, trumpSuit, level));
        const suitGroups = {};
        for (const suit of [SUITS.SPADES, SUITS.HEARTS, SUITS.CLUBS, SUITS.DIAMONDS]) {
            suitGroups[suit] = nonTrumps.filter(c => c.suit === suit);
        }
        for (const suit of Object.keys(suitGroups)) {
            if (suit === currentLeadSuit) continue;
            const pairs = this._findPairs(suitGroups[suit], trumpSuit, level);
            for (const pair of pairs) {
                if (['A', 'K'].includes(pair[0].rank)) return true;
            }
        }

        // 如果手上有分牌且队友可能能帮忙跑分
        const pointCards = hand.filter(c => this._isPointCard(c) && !isTrump(c, trumpSuit, level));
        if (pointCards.length >= 3) return true;

        return false;
    }

    /**
     * 按 value 排序手牌（小→大）
     */
    _sortByValue(cards, trumpSuit, level) {
        return [...cards].sort((a, b) =>
            getCardValue(a, trumpSuit, level) - getCardValue(b, trumpSuit, level)
        );
    }

    /**
     * 找出所有对子，按大小排序（小→大）
     */
    _findPairs(cards, trumpSuit, level) {
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

        pairs.sort((a, b) =>
            getCardValue(a[0], trumpSuit, level) - getCardValue(b[0], trumpSuit, level)
        );

        return pairs;
    }

    /**
     * 找出最好的拖拉机（连对），返回展平的牌数组
     */
    _findBestTractor(cards, trumpSuit, level) {
        const pairs = this._findPairs(cards, trumpSuit, level);
        if (pairs.length < 2) return null;

        const suitPairs = {};
        for (const pair of pairs) {
            const suit = pair[0].suit;
            if (!suitPairs[suit]) suitPairs[suit] = [];
            suitPairs[suit].push(pair);
        }

        for (const suit of Object.keys(suitPairs)) {
            const spairs = suitPairs[suit];
            spairs.sort((a, b) => RANKS.indexOf(a[0].rank) - RANKS.indexOf(b[0].rank));

            let longest = [];
            let current = [spairs[0]];

            for (let i = 1; i < spairs.length; i++) {
                const prevRank = RANKS.indexOf(spairs[i-1][0].rank);
                const currRank = RANKS.indexOf(spairs[i][0].rank);
                if (currRank === prevRank + 1) {
                    current.push(spairs[i]);
                } else {
                    if (current.length > longest.length) longest = current;
                    current = [spairs[i]];
                }
            }
            if (current.length > longest.length) longest = current;

            if (longest.length >= 2) return longest.flat();
        }

        return null;
    }

    /**
     * 找出所有拖拉机
     */
    _findTractors(cards, trumpSuit, level) {
        const pairs = this._findPairs(cards, trumpSuit, level);
        const tractors = [];

        const suitPairs = {};
        for (const pair of pairs) {
            const suit = pair[0].suit;
            if (!suitPairs[suit]) suitPairs[suit] = [];
            suitPairs[suit].push(pair);
        }

        for (const suit of Object.keys(suitPairs)) {
            const spairs = suitPairs[suit];
            spairs.sort((a, b) => RANKS.indexOf(a[0].rank) - RANKS.indexOf(b[0].rank));

            for (let i = 0; i < spairs.length - 1; i++) {
                let sequence = [spairs[i]];
                for (let j = i + 1; j < spairs.length; j++) {
                    const prevRank = RANKS.indexOf(sequence[sequence.length - 1][0].rank);
                    const currRank = RANKS.indexOf(spairs[j][0].rank);
                    if (currRank === prevRank + 1) {
                        sequence.push(spairs[j]);
                    } else {
                        break;
                    }
                }
                if (sequence.length >= 2) {
                    tractors.push(sequence.flat());
                }
            }
        }

        return tractors;
    }
}

// 创建AI实例
const aiPlayers = {
    left: new TractorAI('left'),
    top: new TractorAI('top'),
    right: new TractorAI('right')
};
