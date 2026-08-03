/**
 * 拖拉机 - AI逻辑
 * 智能AI：遵循规则、考虑角色（庄家/闲家）、配合队友、策略性出牌
 *
 * 核心策略：
 * 1. 庄家队首家：出副牌A或强力对子，期望队友跑分
 * 2. 闲家队首家：出小牌过渡，或出长套副牌消耗庄家主牌
 * 3. 跟牌：必须跟同花色，有对跟对；队友赢时跟小牌或贴分，对手赢时出大牌或杀主
 * 4. 分牌管理：5、10、K是分牌，队友赢时贴分，对手赢时保留
 *
 * 截图建议增强：
 * - DEBUG开关：设为true输出AI每一步决策日志
 * - 甩错记忆：记录甩错的牌型，避免AI重复甩错
 * - 随机性：多策略等分时随机选择，防止行为可预测
 * - 终局策略：倒数5张牌考虑抠底保底
 */

// 调试开关（截图建议：增加DEBUG开关，输出AI每一步的评分和选择理由）
const DEBUG = false;

// Node.js环境：从game.js引入所需常量和函数（浏览器环境自动忽略）
if (typeof require !== 'undefined') {
    const _g = require('./game.js');
    // 将game.js的导出合并到全局作用域
    Object.assign(global, _g);
}

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
            },
            trickCount: 0,       // 轮次计数（用于判断开局阶段）
            failedThrows: [],    // 记录甩错的牌型（避免AI重复甩错）
            teammateSmallTrumpLeads: 0,  // 队友首发出小主牌的次数
            lastSmallTrumpLeadTrick: -1, // 上次记录小主牌首发的轮次（防重复计数）
            bottomPoints: null,  // 底牌分数（庄家AI埋底后记录，用于判断是否需要保底策略）
            dealer: null         // 当前庄家位置（由decidePlay同步）
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
     * 统计某玩家在某花色已出过的牌数（用于判断断门可能性）
     * position: 1=首家 2=二家 3=三家 4=四家
     */
    _countSuitPlayedByPlayer(suit, position) {
        const playerMap = { 1: 'bottom', 2: 'right', 3: 'top', 4: 'left' };
        // 注：PLAYERS顺序是 bottom→right→top→left，对应1→2→3→4
        // 但实际出牌顺序取决于首家，这里用近似统计：
        // 统计该花色在已出牌历史中出现的总次数（粗略估计四家可能的走牌量）
        return this.memory.playedCards.filter(c =>
            !c.isJoker && c.suit === suit
        ).length;
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
    //  尾盘策略工具
    //  尾盘核心：最后一轮的赢家决定底牌归属（抠底/保底）
    //  - 庄家方目标：赢最后一轮 → 保底（底牌分数不外流）
    //  - 闲家方目标：赢最后一轮 → 抠底（底牌分数×倍数拿走）
    //  - 大牌不一定是大王，可以是拖拉机/对子/甩牌，但绝大多数情况是大王
    //  - "先出的大王大"：大王作为首家出牌时，跟随者的大王无法杀牌
    //    因此大王应留到最后一轮主动出，而非倒数第二轮提前出
    //    倒数第二轮用较大非大王牌抢出牌权 → 最后一轮主动出大王 → 确保赢
    // ================================================================

    /** 已出过的大王数量（0/1/2） */
    _bigJokersPlayed() {
        return this.memory.playedCards.filter(c => c.isJoker && c.rank === 'big').length;
    }

    /** 已出过的小王数量（0/1/2） */
    _smallJokersPlayed() {
        return this.memory.playedCards.filter(c => c.isJoker && c.rank === 'small').length;
    }

    /** 手中是否有大王 */
    _hasBigJoker(hand) {
        return hand.some(c => c.isJoker && c.rank === 'big');
    }

    /** 手中是否有小王 */
    _hasSmallJoker(hand) {
        return hand.some(c => c.isJoker && c.rank === 'small');
    }

    /**
     * 判断是否进入尾盘
     * 每人25张牌，trick大小不定，用剩余手牌数近似。
     * hand.length <= 6：尾盘，开始留意保底/抠底，留大牌
     */
    _isEndGame(hand) {
        return hand.length <= 6;
    }

    /**
     * 判断是否处于开局阶段
     * hand.length >= 18：开局前2-3轮，出牌权争夺至关重要
     */
    _isEarlyGame(hand) {
        return hand.length >= 18;
    }

    /**
     * 判断是否处于中盘阶段
     * hand.length 在7~17之间：中盘，出牌权开始不那么重要，拦截更重要
     */
    _isMidGame(hand) {
        return hand.length > 6 && hand.length < 18;
    }

    /**
     * 判断是否应该进行拦截
     *
     * 【拦截介入时机规则】
     * 拦截规则的介入时机以"庄家(队友)第一次走单张小主牌"为标志。
     * 庄家第一次出小主牌后，被队友接手或被对手抢走出牌权——这一轮之后，
     * 拦截规则才开始介入。庄家第一次走小主牌的这一轮本身不拦截，而是
     * 用尽全力抢出牌权（因为第一次出牌权最重要，A和强势副牌=分数）。
     *
     * 因此：在尚未发生过"庄家第一次走小主牌后被抢权"的事件时
     * （即 memory.teammateSmallTrumpLeads < 1），处于第一次出牌权争夺阶段，
     * 此时应用尽全力抢出牌权，不做拦截，直接返回 false。
     *
     * 拦截场景（介入后）：中盘，庄家走小牌单张，下家小跟，无分。
     * 此时队友AI要用一张中级牌保证最后一家不轻松跑分。
     *
     * 条件：
     *   0. 已过第一次出牌权争夺阶段（teammateSmallTrumpLeads >= 1）
     *   1. 中盘阶段（手牌7~17张）
     *   2. 桌上无分（trickScore === 0）
     *   3. 非最后一家（后面还有玩家可能跑分）
     *   4. 队友出的是小牌（不是A/K等大牌）
     *
     * @returns {boolean}
     */
    _shouldIntercept(hand, trickCards, trickScore, trumpSuit, level, leadSuit) {
        // 【第一次出牌权争夺阶段不拦截】
        // 庄家(队友)第一次走小主牌前/这一轮，应用尽全力抢出牌权，不拦截。
        // 参考 memory.teammateSmallTrumpLeads：尚未发生首次小主牌首发被抢权事件时，不拦截。
        if (!this.memory.teammateSmallTrumpLeads || this.memory.teammateSmallTrumpLeads < 1) {
            return false;
        }

        // 中盘才拦截
        if (!this._isMidGame(hand)) return false;
        // 有分不拦截（有分时该贴分贴分，该杀杀）
        if (trickScore > 0) return false;
        // 非最后一家才需要拦截（最后一家时队友已赢，贴分即可）
        if (trickCards.length >= 3) return false;

        return true;
    }

    /**
     * 找到用于拦截的副牌
     *
     * 拦截策略：用J/Q等中级牌拦截，防止最后一家出10得分的可能性。
     * - 不用A（中盘AK大概率走完了，留着也是浪费）
     * - 不用K（如果有K是最后一家的那是他的分，拦不住）
     * - 优先用J/Q，其次用其他中级牌（7~9如果比当前赢家大）
     * - 不用分牌（5/10/K）
     * - 不拆对子
     *
     * @param {Array} leadSuitCards - 该花色的手牌（已排序，小→大）
     * @returns {Object|null} 拦截牌，或null
     */
    _findInterceptCard(leadSuitCards, trumpSuit, level) {
        if (!leadSuitCards || leadSuitCards.length === 0) return null;

        // 找出当前赢家的牌值
        // leadSuitCards已排序小→大，我们需要出一张比当前赢家大的中级牌

        // 优先用J或Q拦截（最理想的拦截牌）
        const jqCards = leadSuitCards.filter(c => {
            if (this._isPointCard(c)) return false; // 不用分牌
            const val = getCardValue(c, trumpSuit, level);
            // J=9, Q=10 在RANKS中的index，副牌value就是index
            return c.rank === 'J' || c.rank === 'Q';
        });
        if (jqCards.length > 0) {
            return jqCards[0]; // 最小的J或Q
        }

        // 没有J/Q，看有没有其他中级非分牌（7/8/9）比当前桌面最大牌大
        // 找出非分牌中最大的
        const midCards = leadSuitCards.filter(c => {
            if (this._isPointCard(c)) return false;
            // 排除A（太大，留着）和K（是分牌已被排除）
            if (c.rank === 'A') return false;
            return ['7', '8', '9'].includes(c.rank);
        });
        if (midCards.length > 0) {
            return midCards[midCards.length - 1]; // 最大的中级牌
        }

        // 实在没有合适的拦截牌，返回null（走默认逻辑）
        return null;
    }

    /**
     * 三家单张拦截牌选择（用户补充策略）
     *
     * 用户策略："要么用绝对大牌上手比如黑桃A，若没有黑桃A，
     *   至少要用黑桃JQ之类，防止第四家用黑桃10轻易得分。
     *   第四家的黑桃K，本来就防不住，也就不必考虑防御。"
     *
     * 优先级：
     *   1. A（绝对大牌上手）——不拆对
     *   2. K（如果手里有K，压过二家的J/Q，防四家跑10）
     *      注意：K是分牌，但在拦截场景下如果A/J/Q都拦不住，可用K
     *   3. J/Q（中级拦截牌）
     *   4. 7/8/9中最大的（勉强拦截）
     *
     * @param {Array} leadSuitCards - 该花色手牌（已排序小→大）
     * @param {number} winnerValue - 当前赢家的牌值
     * @param {string} trumpSuit - 主花色
     * @param {string} level - 级别
     * @returns {Object|null} 拦截牌，或null
     */
    _findSingleInterceptCard(leadSuitCards, winnerValue, trumpSuit, level) {
        if (!leadSuitCards || leadSuitCards.length === 0) return null;

        const pairs = this._findPairs(leadSuitCards, trumpSuit, level);
        const isInPair = (card) => pairs.some(p => p.some(pc => pc.id === card.id));

        // 1. 优先用A（绝对大牌上手）——不拆对
        const ace = leadSuitCards.find(c => {
            if (c.rank !== 'A') return false;
            if (getCardValue(c, trumpSuit, level) <= winnerValue) return false;
            return !isInPair(c);
        });
        if (ace) return ace;

        // 2. 用K（分牌但在拦截场景可接受）——不拆对
        const king = leadSuitCards.find(c => {
            if (c.rank !== 'K') return false;
            if (getCardValue(c, trumpSuit, level) <= winnerValue) return false;
            return !isInPair(c);
        });
        if (king) return king;

        // 3. 用J/Q拦截
        const jq = leadSuitCards.find(c => {
            if (c.rank !== 'J' && c.rank !== 'Q') return false;
            if (this._isPointCard(c)) return false;
            if (getCardValue(c, trumpSuit, level) <= winnerValue) return false;
            return !isInPair(c);
        });
        if (jq) return jq;

        // 4. 用7/8/9中最大的能赢的牌
        const midCards = leadSuitCards.filter(c => {
            if (this._isPointCard(c)) return false;
            if (c.rank === 'A' || c.rank === 'K') return false;
            if (getCardValue(c, trumpSuit, level) <= winnerValue) return false;
            return ['7', '8', '9'].includes(c.rank);
        });
        if (midCards.length > 0) return midCards[midCards.length - 1];

        return null;
    }

    /**
     * 找到用于拦截的主牌
     *
     * 主牌拦截策略：用A/级牌拦截，防止最后一家轻松跑分。
     * - 优先用单张主牌A（最有价值的拦截牌）
     * - 其次用主级牌（级牌也是强主牌）
     * - 不轻易拆A对或级牌对（保留用于抠底/毙杀）
     * - 必要时可用王（但中盘不太建议，除非无其他选择）
     *
     * @param {Array} trumps - 主牌（已排序，小→大）
     * @param {Array} trickCards - 当前桌面牌
     * @returns {Object|null} 拦截牌，或null
     */
    _findInterceptTrump(trumps, trickCards, trumpSuit, level) {
        if (!trumps || trumps.length === 0) return null;

        const winner = getTrickWinner(trickCards, trumpSuit, level, this.memory.playedCards);
        const winnerValue = getCardValue(winner.cards[0], trumpSuit, level);

        // 找出所有比当前赢家大的主牌
        const biggerTrumps = trumps.filter(c =>
            getCardValue(c, trumpSuit, level) > winnerValue
        );
        if (biggerTrumps.length === 0) return null;

        // 1. 优先用单张主牌A（主花色的A）
        //    主花色A的value在200~211范围内（取决于是否是级牌）
        const trumpAce = biggerTrumps.find(c => {
            if (c.isJoker) return false;
            if (c.rank !== 'A') return false;
            // 检查是否是单张（不在对子中）
            const pairs = this._findPairs(trumps, trumpSuit, level);
            const inPair = pairs.some(p => p.some(pc => pc.id === c.id));
            return !inPair; // 只用单张A，不拆对
        });
        if (trumpAce) return trumpAce;

        // 2. 用主级牌（级牌单张）
        //    主级牌value=213，副级牌value=212
        const levelCard = biggerTrumps.find(c => {
            if (c.isJoker) return false;
            if (c.rank !== level) return false; // 级牌
            const val = getCardValue(c, trumpSuit, level);
            if (val < 212) return false; // 确认是级牌
            // 检查是否是单张
            const pairs = this._findPairs(trumps, trumpSuit, level);
            const inPair = pairs.some(p => p.some(pc => pc.id === c.id));
            return !inPair; // 只用单张级牌，不拆对
        });
        if (levelCard) return levelCard;

        // 3. 用其他较大的非王主牌（主花色K/Q/J等）
        const otherBigTrump = biggerTrumps.find(c => {
            if (c.isJoker) return false;
            const val = getCardValue(c, trumpSuit, level);
            if (val >= 212) return false; // 跳过级牌（上面已处理）
            // 检查是否是单张
            const pairs = this._findPairs(trumps, trumpSuit, level);
            const inPair = pairs.some(p => p.some(pc => pc.id === c.id));
            return !inPair;
        });
        if (otherBigTrump) return otherBigTrump;

        // 4. 最后考虑用王（小王优先，大王太珍贵）
        //    只有在中盘且无其他选择时才用
        //    底牌≤5分时放宽：大王不必留给保底，可用于拦截
        const smallJoker = biggerTrumps.find(c => c.isJoker && c.rank === 'small');
        if (smallJoker) return smallJoker;

        // 底牌≤5分时，大王也愿意用于拦截（不值得为保底留大王）
        if (this._shouldSkipBottomProtection()) {
            const bigJoker = biggerTrumps.find(c => c.isJoker && c.rank === 'big');
            if (bigJoker) return bigJoker;
        }

        // 底牌>5分时不用大王拦截（太珍贵，留给尾盘保底/抠底）
        return null;
    }

    /**
     * 三家后续小主牌拦截：用级牌/中级主牌拦截，不浪费大小王
     *
     * 用户策略："首家队友第二次开始出小单主牌，仅需用拦截的思路确保对手方不跑分即可"
     * 主牌里可用作拦截的牌特别多，因为有很多级牌。
     *
     * 优先级（不用王！）：
     *   1. 副级牌（单张，value=212）
     *   2. 主级牌（单张，value=213）
     *   3. 主花色大普通牌（A/K/Q，不拆对）
     *   4. 其他能赢的中级主牌
     *
     * @param {Array} trumps - 主牌（已排序小→大）
     * @param {number} winnerValue - 当前赢家的牌值
     * @param {string} trumpSuit - 主花色
     * @param {string} level - 当前级别
     * @param {boolean} isLastTrick - 是否最后一轮
     * @param {Array} hand - 手牌
     * @returns {Object|null} 拦截牌，或null
     */
    _findTrumpInterceptCard(trumps, winnerValue, trumpSuit, level, isLastTrick, hand) {
        if (!trumps || trumps.length === 0) return null;

        const pairs = this._findPairs(trumps, trumpSuit, level);
        const isInPair = (card) => pairs.some(p => p.some(pc => pc.id === card.id));

        const candidates = [];
        for (const t of trumps) {
            const val = getCardValue(t, trumpSuit, level);
            if (val <= winnerValue) continue;

            let priority = 0;
            if (!t.isJoker && t.rank === level && t.suit !== trumpSuit) priority = 80; // 副级牌
            else if (!t.isJoker && t.rank === level && t.suit === trumpSuit) priority = 70; // 主级牌
            else if (!t.isJoker && t.rank === 'A') priority = 60; // 主花色A
            else if (!t.isJoker && !this._isPointCard(t)) priority = val; // 其他非分主牌
            else continue; // 跳过分牌和王

            // 不拆对子
            if (isInPair(t)) continue;

            candidates.push({ card: t, priority });
        }

        if (candidates.length === 0) return null;
        candidates.sort((a, b) => b.priority - a.priority);
        return candidates[0].card;
    }

    /**
     * 判断四家（对手）是否可能有分数牌
     * 用于三家决策：是否需要压制二家
     *
     * 用户策略："除非牌面已经判断出，四家手中无分数牌，那可以放过"
     *
     * 判断依据：
     *   1. 四家已断门 → 无同花色分牌
     *   2. 分牌(5/10/K)已大量出过 → 可能没有了
     *   3. 自己手里有很多分牌 → 对手可能没有了
     *
     * @param {Array} trickCards - 桌面牌
     * @param {string} trumpSuit - 主花色
     * @param {string} level - 级别
     * @param {Array} hand - 手牌
     * @param {string} leadPlayer - 首家
     * @returns {boolean} true=可能有分牌（需压制），false=大概率无分牌（可放过）
     */
    _opponentLikelyHasScore(trickCards, trumpSuit, level, hand, leadPlayer) {
        // 确定四家是谁
        const players = ['bottom', 'right', 'top', 'left'];
        const leadIdx = players.indexOf(leadPlayer);
        const fourthPlayer = players[(leadIdx + 3) % 4];

        // 如果是队友（不应该，但保险），默认需要压制
        if (this._isTeammate(fourthPlayer)) return true;

        const leadSuit = getLeadSuit(trickCards[0].cards, trumpSuit, level);

        // 四家已断该花色 → 不可能用该花色分牌
        // 但如果是主牌局，断门意味着可以杀主，仍可能有主牌分牌
        if (leadSuit !== null && this._isPlayerVoid(fourthPlayer, leadSuit)) {
            // 断门了，但如果手上有主牌分牌(主10/主K/主5)仍可能跑分
            // 统计已出的主牌分牌
            const playedTrumpScore = this.memory.playedCards.filter(c =>
                isTrump(c, trumpSuit, level) && this._isPointCard(c)
            ).length;
            if (playedTrumpScore >= 6) return false; // 主牌分牌基本出完了
            return true; // 仍可能有主牌分牌
        }

        // 统计该花色已出的分牌数（两副牌共8张：2x5, 2x10, 2xK = 6张分牌... 不对，2副x3种=6张）
        // 实际：每副牌有5/10/K各1张，2副牌共6张分牌
        const totalScoreCards = 6;
        const playedScore = this.memory.playedCards.filter(c => {
            if (c.isJoker) return false;
            if (isTrump(c, trumpSuit, level)) return false;
            if (leadSuit !== null && c.suit !== leadSuit) return false;
            return this._isPointCard(c);
        }).length;

        // 自己手里的该花色分牌
        const myScore = hand.filter(c => {
            if (c.isJoker) return false;
            if (isTrump(c, trumpSuit, level)) return false;
            if (leadSuit !== null && c.suit !== leadSuit) return false;
            return this._isPointCard(c);
        }).length;

        // 首家+二家出的分牌
        const tableScore = trickCards.flatMap(t => t.cards).filter(c =>
            !c.isJoker && !isTrump(c, trumpSuit, level) &&
            (leadSuit === null || c.suit === leadSuit) &&
            this._isPointCard(c)
        ).length;

        // 已出+自己手里+桌面的分牌
        const accountedScore = playedScore + myScore + tableScore;
        // 如果几乎所有分牌都已accounted for，四家可能没有了
        if (accountedScore >= totalScoreCards - 1) return false;

        return true;
    }

    /**
     * 判断一张主牌是否为"强势主牌"（王或级牌）
     */
    _isStrongTrump(card, trumpSuit, level) {
        if (card.isJoker) return true;
        if (card.rank === level) return true; // 主级牌/副级牌
        return false;
    }

    /**
     * 统计两副牌中"强势主牌"（王+级牌）还有多少在外
     * （未出过、不在自己手中、不在本轮桌面）。强势主牌共12张：4王+8级牌。
     */
    _countOutstandingStrongTrumps(trumpSuit, level, hand, trickCards) {
        const isStrong = c => isTrump(c, trumpSuit, level) && this._isStrongTrump(c, trumpSuit, level);
        const accounted = this.memory.playedCards.filter(isStrong).length
            + (hand || []).filter(isStrong).length
            + trickCards.flatMap(t => t.cards).filter(isStrong).length;
        return Math.max(0, 12 - accounted);
    }

    /**
     * 统计两副牌中比 winnerValue 更大的主牌还有多少"在外"
     * （未出过、不在自己手中、不在本轮桌面）—— 可能在对手手中反超。
     * 用于判断队友首发的主牌能否稳赢（如大王必然稳赢）。
     */
    _countOutstandingBiggerTrumps(winnerValue, trumpSuit, level, hand, trickCards) {
        const isBigger = c => isTrump(c, trumpSuit, level) &&
            getCardValue(c, trumpSuit, level) > winnerValue;
        const accounted = this.memory.playedCards.filter(isBigger).length
            + (hand || []).filter(isBigger).length
            + trickCards.flatMap(t => t.cards).filter(isBigger).length;
        let total = 0;
        if (215 > winnerValue) total += 2; // 大王
        if (214 > winnerValue) total += 2; // 小王
        if (trumpSuit) {
            if (213 > winnerValue) total += 2; // 主级牌
            if (212 > winnerValue) total += 6; // 副级牌(3花色×2)
            for (let v = 200; v <= 211; v++) {
                if (v > winnerValue) total += 2; // 主花色普通牌(12个value各2张)
            }
        } else {
            // 无主：所有级牌value=212，共8张
            if (212 > winnerValue) total += 8;
        }
        return Math.max(0, total - accounted);
    }

    /**
     * 判断二家（对手）是否"早已拿过出牌权、基本无强势牌"
     * 用于三家决定是否可放过二家的杀牌。保守判断：仅当场上强势主牌基本出尽，
     * 或二家本轮已用强势主牌杀且所剩强势主牌极少时，才认为二家无后续威胁。
     */
    _isSecondPlayerWeak(trickCards, trumpSuit, level, hand) {
        const outstandingStrong = this._countOutstandingStrongTrumps(trumpSuit, level, hand, trickCards);
        if (outstandingStrong === 0) return true; // 强势主牌已全部出尽，二家必无强势牌
        const secondCards = trickCards.length >= 2 ? trickCards[1].cards : [];
        const secondUsedStrong = secondCards.length > 0 && secondCards.some(c =>
            isTrump(c, trumpSuit, level) && this._isStrongTrump(c, trumpSuit, level));
        return secondUsedStrong && outstandingStrong <= 1;
    }

    /**
     * 评估队友当前赢着的对子最终能否赢下来（用于非最后家决定是否配合跑分）
     * 综合走牌历史：后续对手是否断门（可能杀主反超）、更大的同花色对子是否还在场上。
     * @returns {boolean} true=大概率能赢（可配合跑分），false=有被反超风险（保守跟小牌）
     */
    _teammatePairLikelyWin(trickCards, trumpSuit, level, hand, leadSuit, leadPlayer, isLastPlayer) {
        if (isLastPlayer) return true; // 最后家，已经赢了
        const winner = getTrickWinner(trickCards, trumpSuit, level, this.memory.playedCards);
        const winnerValue = getCardValue(winner.cards[0], trumpSuit, level);
        const winnerIsTrump = isTrump(winner.cards[0], trumpSuit, level);
        const players = ['bottom', 'right', 'top', 'left'];
        const leadIdx = players.indexOf(leadPlayer);
        const playedCount = trickCards.length;

        let opponentRemains = false;
        for (let i = playedCount; i < 4; i++) {
            const p = players[(leadIdx + i) % 4];
            if (this._isTeammate(p)) continue; // 队友不会反超自己人
            opponentRemains = true;
            // 对手断门 → 可能杀主反超
            if (leadSuit !== null && this._isPlayerVoid(p, leadSuit)) {
                return false;
            }
        }
        if (!opponentRemains) return true; // 后续全是队友，稳赢

        // 对手未断门：判断是否可能持有更大同花色对子
        if (!winnerIsTrump && leadSuit !== null) {
            const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
            // winnerValue是副牌RANKS下标；逐个更大的rank检查该rank两张是否都在外
            for (let v = winnerValue + 1; v <= 12; v++) {
                if (RANKS[v] === level) continue; // 级牌成为主牌，不在副牌中
                const rank = RANKS[v];
                const accounted = this.memory.playedCards.filter(c =>
                        !c.isJoker && c.suit === leadSuit && c.rank === rank).length
                    + (hand || []).filter(c => !c.isJoker && c.suit === leadSuit && c.rank === rank).length
                    + trickCards.flatMap(t => t.cards).filter(c =>
                        !c.isJoker && c.suit === leadSuit && c.rank === rank).length;
                if (2 - accounted >= 2) {
                    return false; // 该rank两张都在外，对手可能凑成更大对子反超
                }
            }
        }
        return true;
    }

    /**
     * 判断出牌模式中的主牌是否是小主牌
     * 小主牌定义：主花色普通小牌（value 200~208），不是级牌，不是王
     */
    _isSmallTrumpCard(cards, trumpSuit, level) {
        if (!cards || cards.length === 0) return false;
        const card = cards[0];
        if (!isTrump(card, trumpSuit, level)) return false;
        const val = getCardValue(card, trumpSuit, level);
        // 主花色普通小牌：200~208，不含级牌(212/213)和王(220+)
        return val >= 200 && val <= 208;
    }

    /**
     * 抢出牌权：从主牌中选出最适合抢权的牌
     * 优先用王/级牌等超强牌，确保对手难以反超
     * 优先级：小王 > 大王(尾盘除外) > 主级牌 > 副级牌 > 最大可用主牌
     *
     * @param {Array} trumps - 已按value升序排列的主牌
     * @param {number} winnerValue - 当前赢家的牌值
     * @param {string} trumpSuit - 主花色
     * @param {string} level - 当前级别
     * @param {boolean} isLastTrick - 是否最后一轮
     * @param {Array} hand - 手牌（用于判断尾盘）
     * @returns {Object|null} 最佳抢权牌，null表示争不过
     */
    _grabControlCard(trumps, winnerValue, trumpSuit, level, isLastTrick, hand) {
        const candidates = [];
        for (const t of trumps) {
            const val = getCardValue(t, trumpSuit, level);
            if (val <= winnerValue) continue; // 必须能赢当前赢家

            let priority = 0;
            if (t.isJoker && t.rank === 'small') priority = 100;
            else if (t.isJoker && t.rank === 'big') priority = 99;
            else if (!t.isJoker && t.rank === level && t.suit === trumpSuit) priority = 90;
            else if (!t.isJoker && t.rank === level) priority = 80;
            else priority = val;

            // 尾盘非最后一轮：保留大王（底牌>5分时才需要保底留大王）
            if (t.isJoker && t.rank === 'big' && !isLastTrick && this._isEndGame(hand) && !this._shouldSkipBottomProtection()) {
                priority = -1;
            }
            candidates.push({ card: t, priority });
        }

        if (candidates.length === 0) return null;
        candidates.sort((a, b) => b.priority - a.priority);
        return candidates[0].card;
    }

    /**
     * 判断是否进入关键尾盘（最后1-2轮）
     * hand.length <= 4：出牌权争夺至关重要，但大王留到最后一轮才出
     */
    _isCriticalEndGame(hand) {
        return hand.length <= 4;
    }

    /**
     * 判断当前是否可能是最后一轮
     * 每家剩余手牌数 == 首家本轮出牌张数时，这就是最后一轮
     */
    _isLikelyLastTrick(hand, leadPattern) {
        return leadPattern && hand.length === leadPattern.length;
    }

    /**
     * 判断队友是否可能杀牌（用于主动加分）
     *
     * 条件：
     *   1. 队友还没出牌（在我之后出牌）
     *   2. 队友很可能断了首家花色（有断门记录，或从跟牌推断）
     *   3. 队友可能有主牌（早期轮次一般都有主牌）
     *
     * @param {string} leadSuit - 首家花色
     * @param {Array} trickCards - 当前桌面牌
     * @returns {boolean}
     */
    _teammateLikelyToKill(leadSuit, trickCards, trumpSuit, level) {
        // 找到队友
        const teammate = this._getTeammate();
        if (!teammate) return false;

        // 队友已经出过牌了，不会再杀
        const teammatePlayed = trickCards.some(t => t.player === teammate);
        if (teammatePlayed) return false;

        // 队友在场上位置：判断是否在我之后出牌（还能杀）
        // trickCards.length: 0=首家,1=第二家,2=第三家,3=第四家
        // 我是第 (trickCards.length+1) 家，队友若还没出则在我之后
        // 这已经由 teammatePlayed 判断覆盖

        // 队友断了该花色（记忆中有记录）→ 很可能杀
        if (leadSuit && this._isPlayerVoid(teammate, leadSuit)) {
            return true;
        }

        // 没有明确断门记录，但这是早期（队友大概率有主牌）且该花色很少出过
        // 此时无法确定，保守返回false（不冒进加分）
        return false;
    }

    /** 获取队友位置 */
    _getTeammate() {
        if (this.position === 'bottom') return 'top';
        if (this.position === 'top') return 'bottom';
        if (this.position === 'left') return 'right';
        if (this.position === 'right') return 'left';
        return null;
    }

    /**
     * 判断我是否有能力/有必要在最后一轮赢牌
     * （手中是否有能确保赢最后一轮的大牌：大王/小王/主级对/拖拉机）
     */
    _hasLastTrickWeapon(hand, trumpSuit, level) {
        // 大王：最强保底/抠底武器
        if (this._hasBigJoker(hand)) return true;
        // 小王（大王已全出时也是武器）
        if (this._hasSmallJoker(hand) && this._bigJokersPlayed() >= 2) return true;
        // 主牌拖拉机
        const trumps = hand.filter(c => isTrump(c, trumpSuit, level));
        const tractors = this._findTractors(trumps, trumpSuit, level);
        if (tractors.length > 0 && hand.length >= 4) return true;
        return false;
    }

    // ================================================================
    //  叫主决策
    // ================================================================

    decideBid(hand, level, currentBid) {
        const suitStrength = {};
        for (const suit of [SUITS.SPADES, SUITS.HEARTS, SUITS.CLUBS, SUITS.DIAMONDS]) {
            const suitCards = hand.filter(c => c.suit === suit && !c.isJoker);
            const levelCards = suitCards.filter(c => c.rank === level);
            const highCards = suitCards.filter(c => ['A', 'K', 'Q', 'J'].includes(c.rank));
            let strength = 0;
            strength += levelCards.length * 10;
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

        // 统计各花色长度（级牌除外，级牌无论是否主都是主牌）
        const suitLen = {};
        for (const suit of [SUITS.SPADES, SUITS.HEARTS, SUITS.CLUBS, SUITS.DIAMONDS]) {
            suitLen[suit] = hand.filter(c => !c.isJoker && c.suit === suit && c.rank !== level).length;
        }

        const handSize = hand.length;
        const trumpRelatedCount = hand.filter(c =>
            c.isJoker || c.rank === level
        ).length;

        // 反主决策：
        //   1. 长套花色的级牌对子反主 → 把长套变成主牌，获得主牌数量优势
        //      （如3张黑桃8张红桃+红桃级牌对，反主让红桃成主牌）
        //   2. 常主多（王+级牌≥4）或抓牌接近结束（handSize>=20）→ 反主
        const pairLevelBids = counterBids.filter(b => b.type === BID_TYPES.PAIR_LEVEL);

        // 优先：长套花色（≥7张）的级牌对子反主，夺取主牌数量优势
        for (const bid of pairLevelBids) {
            if (suitLen[bid.suit] >= 7) return bid;
        }

        // 有级牌对子或王对时，门槛降低（有强牌在手，中后期即可反主）
        const noTrumpBids = counterBids.filter(b =>
            b.type === BID_TYPES.PAIR_SMALL_JOKER || b.type === BID_TYPES.PAIR_BIG_JOKER
        );
        const hasStrongCounter = pairLevelBids.length > 0 || noTrumpBids.length > 0;
        const shouldCounter = trumpRelatedCount >= 4 || handSize >= 15 || hasStrongCounter;
        if (!shouldCounter) return null;

        // 有级牌对子时，优先用最长套的级牌对反主（而非反无主），
        // 以获得主牌数量优势；只有王对才反无主
        if (pairLevelBids.length > 0) {
            pairLevelBids.sort((a, b) => suitLen[b.suit] - suitLen[a.suit]);
            return pairLevelBids[0];
        }

        // ═══════════════════════════════════════════════════════════════
        //  无主反主决策（王对反主）—— 不要盲目反无主
        // ═══════════════════════════════════════════════════════════════
        // 无主通常不是好局面：
        //   - 主牌只有12张常主，每人平均3张，断门也难毙杀
        //   - 只有两种情况下适合叫无主：
        //     1. 庄家式：副牌强势 + 主牌不理想 → 规避主牌弱势，发挥副牌优势
        //     2. 捣乱式：别人已叫主 + 自己主牌不理想 → 抹掉庄家主牌优势
        //   - 主牌强势时绝不应叫无主（放弃自己的主牌优势太傻）
        if (noTrumpBids.length > 0) {
            // 评估主牌理想程度
            const bigJokers = hand.filter(c => c.isJoker && c.rank === 'big');
            const smallJokers = hand.filter(c => c.isJoker && c.rank === 'small');
            const levelCards = hand.filter(c => c.rank === level);

            // 主牌评分：大王(+4) 小王(+3) 级牌(+2)
            let trumpScore = bigJokers.length * 4 + smallJokers.length * 3 + levelCards.length * 2;

            // 如果已有叫主花色，该花色非级牌牌张 → 反无主会损失这些主牌
            // 只给大牌（A/K/Q/J）计较高损失，小牌损失很小
            if (currentBid && currentBid.suit) {
                const currentTrumpSuitCards = hand.filter(c =>
                    c.suit === currentBid.suit && !c.isJoker && c.rank !== level
                );
                const highCards = currentTrumpSuitCards.filter(c =>
                    ['A', 'K', 'Q', 'J'].includes(c.rank)
                );
                const lowCards = currentTrumpSuitCards.filter(c =>
                    !['A', 'K', 'Q', 'J'].includes(c.rank)
                );
                trumpScore += highCards.length * 1.0 + lowCards.length * 0.3;
            }

            // 副牌评分：评估副牌强势程度
            let sideSuitScore = 0;
            for (const suit of [SUITS.SPADES, SUITS.HEARTS, SUITS.CLUBS, SUITS.DIAMONDS]) {
                if (currentBid && suit === currentBid.suit) continue;
                const sCards = hand.filter(c => c.suit === suit && !c.isJoker && c.rank !== level);
                for (const c of sCards) {
                    if (c.rank === 'A') sideSuitScore += 3;
                    else if (c.rank === 'K') sideSuitScore += 2;
                    else if (c.rank === 'Q') sideSuitScore += 1.5;
                    else if (c.rank === 'J') sideSuitScore += 1;
                    else if (c.rank === '10') sideSuitScore += 0.5;
                }
                // 对子额外加分
                const pairs = this._findPairs(sCards, currentBid ? currentBid.suit : null, level);
                sideSuitScore += pairs.length * 2;
            }

            let shouldNoTrump = false;

            // 主牌很不理想时，才考虑无主
            if (trumpScore <= 8) {
                if (sideSuitScore >= 12) {
                    // 副牌强势 + 主牌弱 → 庄家式叫无主
                    // 规避主牌弱势，强行把大家主牌拉到同一水平，发挥副牌优势
                    shouldNoTrump = true;
                } else if (currentBid) {
                    // 别人已叫主，自己主牌不理想 → 捣乱式反无主
                    // 抹掉庄家主牌优势，把胜率从~10%提升到~40%
                    shouldNoTrump = true;
                }
            } else if (trumpScore <= 10 && sideSuitScore >= 12) {
                // 主牌一般偏弱但副牌强势 → 也可以叫无主发挥副牌优势
                shouldNoTrump = true;
            }

            // 主牌强势时绝不叫无主（放弃自己的主牌优势太傻）
            if (trumpScore >= 12) {
                shouldNoTrump = false;
            }

            if (shouldNoTrump) {
                noTrumpBids.sort((a, b) => b.power - a.power);
                return noTrumpBids[0];
            }
        }

        // 没有级牌对子，也不适合无主 → 不反主
        return null;
    }

    // ================================================================
    //  埋底决策
    // ================================================================

    /**
     * 埋底决策（庄家专用）
     *
     * 核心规则——抠底惩罚：
     *   最后一轮如果闲家获胜，底牌中的分牌会按倍数惩罚：
     *     - 单张抠底：底牌分数 × 2
     *     - 对子抠底：底牌分数 × 4
     *     - 拖拉机抠底：底牌分数 × 8
     *   庄家方获胜则底牌分数原样归还（无惩罚）。
     *
     * 策略综合考量：
     *   1. 主牌强度评估：主牌多且强（有大小王、主级对、长主套）→
     *      有信心保证最后一轮胜利，可以冒险埋分牌断门
     *   2. 主牌短而弱 → 放弃断门便利，不埋分牌，宁可不断门
     *   3. 断门便利性：断1-2门副牌可以减少防守压力，但有时
     *      需要埋几张副牌分牌才能实现断门
     *   4. 分牌风险：5（5分）、10/K（10分），埋下去如果被抠底
     *      损失惨重（×2~×8）
     *
     * @param {Array} hand - 手牌（含底牌共36张）
     * @param {string|null} trumpSuit - 主花色
     * @param {string} level - 当前级别
     * @returns {Array} 要埋的8张牌
     */
    decideBury(hand, trumpSuit, level) {
        // === 第一步：评估主牌强度 ===
        const trumps = hand.filter(c => isTrump(c, trumpSuit, level));
        const trumpStrength = this._evaluateTrumpStrength(trumps, trumpSuit, level);

        // === 第二步：分析各副牌花色 ===
        const suitAnalysis = {};
        for (const suit of [SUITS.SPADES, SUITS.HEARTS, SUITS.CLUBS, SUITS.DIAMONDS]) {
            if (suit === trumpSuit) continue; // 主花色不埋
            const cards = hand.filter(c => c.suit === suit && !isTrump(c, trumpSuit, level));
            const pointCards = cards.filter(c => this._isPointCard(c));
            suitAnalysis[suit] = {
                cards: cards,
                count: cards.length,
                points: pointCards,
                pointValue: pointCards.reduce((s, c) => s + this._getCardScore(c), 0)
            };
        }

        // === 第三步：根据主牌强度决定策略 ===
        // trumpStrength: 0~100
        //   >=70: 强主牌，可以冒险埋分牌断门
        //   40~69: 中等，谨慎埋分牌
        //   <40: 弱主牌，不埋分牌，放弃断门便利
        //
        // 底牌保护信心：大王是保底最强武器
        //   有大王（尤其对大王）→ 最后一轮能保底，可放心埋分
        //   无大王且大王未出（可能在对手手中）→ 保底风险高，少埋分
        const myBigJokers = trumps.filter(c => c.isJoker && c.rank === 'big').length;
        // 埋牌时尚未出牌，memory为空；大王共2张
        // 有大王→保底信心强；无大王→风险高（对手可能有大王抠底）
        const hasBottomProtection = myBigJokers >= 1;

        let canRiskBuryingPoints = trumpStrength >= 60;
        let canBreakSuit = trumpStrength >= 40;
        // 有大王时提升保底信心，放宽埋分门槛
        if (hasBottomProtection) {
            canRiskBuryingPoints = canRiskBuryingPoints || trumpStrength >= 45;
            canBreakSuit = canBreakSuit || trumpStrength >= 30;
        }
        // 无大王且主牌不强 → 进一步收紧（对手可能抠底）
        if (!hasBottomProtection && trumpStrength < 50) {
            canRiskBuryingPoints = false;
            canBreakSuit = canBreakSuit && false; // 弱主+无大王，不断门
        }

        // === 第四步：选择埋牌 ===
        const toBury = [];
        const usedIds = new Set();

        // 4a. 尝试断门短套副牌（2-4张的副牌花色）
        //     断门可以减少防守压力，但要权衡分牌风险
        //
        //     AQQ技巧：含A（或KK/QQ强对子）的花色不整体埋掉断门——
        //     留下AQQ先打A（必赢），再打QQ（大概率赢），打光后自然断门，
        //     既赢墩又不浪费强牌。只有全是小牌的短套才直接埋掉断门。
        const shortSuits = Object.entries(suitAnalysis)
            .filter(([s, info]) => info.count >= 1 && info.count <= 4)
            .filter(([s, info]) => {
                // 含A的花色保留（留A打出去再造断门，A必赢一墩）
                if (info.cards.some(c => c.rank === 'A')) return false;
                // 含KK/QQ对子的短套也保留（强对子可打出赢墩后断门）
                const hasStrongPair = info.cards.some(c => c.rank === 'K' || c.rank === 'Q') &&
                    this._findPairs(info.cards, trumpSuit, level).length > 0;
                if (hasStrongPair) return false;
                return true;
            })
            .sort((a, b) => {
                // 优先断分牌少的花色（风险低）
                const aRisk = a[1].pointValue;
                const bRisk = b[1].pointValue;
                if (canRiskBuryingPoints) {
                    // 强主牌：优先断短套，不管分牌
                    return a[1].count - b[1].count;
                }
                // 弱主牌：优先断无分牌的短套
                if (aRisk === 0 && bRisk > 0) return -1;
                if (bRisk === 0 && aRisk > 0) return 1;
                return a[1].count - b[1].count;
            });

        for (const [suit, info] of shortSuits) {
            if (toBury.length >= 8) break;
            if (!canBreakSuit && info.pointValue > 0) continue; // 弱主牌不埋分牌

            // 如果埋分牌但主牌不够强，限制只埋1-2张分牌
            if (!canRiskBuryingPoints && info.pointValue > 0 && info.pointValue > 10) {
                // 分牌太多且主牌不够强，不埋这个花色
                continue;
            }

            // 埋掉整个短套
            for (const card of info.cards) {
                if (toBury.length >= 8) break;
                if (!usedIds.has(card.id)) {
                    toBury.push(card);
                    usedIds.add(card.id);
                }
            }
        }

        // 4b. 如果还不够8张，补充副牌小牌（非分牌优先）
        if (toBury.length < 8) {
            const candidates = hand
                .filter(c => !isTrump(c, trumpSuit, level) && !usedIds.has(c.id))
                .sort((a, b) => {
                    // 非分牌优先，然后按大小排（小的先埋）
                    const aPoint = this._isPointCard(a) ? 1 : 0;
                    const bPoint = this._isPointCard(b) ? 1 : 0;
                    if (aPoint !== bPoint) return aPoint - bPoint;
                    return getCardValue(a, trumpSuit, level) - getCardValue(b, trumpSuit, level);
                });

            for (const card of candidates) {
                if (toBury.length >= 8) break;
                // 弱主牌时不埋分牌
                if (!canRiskBuryingPoints && this._isPointCard(card)) continue;
                toBury.push(card);
                usedIds.add(card.id);
            }
        }

        // 4c. 警告：埋主牌的概率极低
        //     埋底牌会削弱主牌控制力，正常情况下副牌（4a/4b）足以埋满8张。
        //     只有副牌实在不够埋时才考虑埋主牌，且即使要埋，也只能埋
        //     "非分、非对的小主牌"——绝不能埋分牌（埋底等于白送分）或对子
        //     （对子是重要的控制资源，不能浪费在底牌里）。
        if (toBury.length < 8) {
            console.warn('[埋底] 副牌不足以埋满8张，需埋主牌补足——这种情况极少出现，仅埋非分非对小主牌');

            // 收集主牌中的对子牌ID，这些牌受保护不能埋（保留对子控制资源）
            const trumpPairs = this._findPairs(trumps, trumpSuit, level);
            const pairCardIds = new Set();
            for (const pair of trumpPairs) {
                pairCardIds.add(pair[0].id);
                pairCardIds.add(pair[1].id);
            }

            // 仅埋"非分、非对、非级牌非王"的小主牌，严格过滤
            const safeTrumpCandidates = trumps
                .filter(c => !usedIds.has(c.id))
                .filter(c => !this._isPointCard(c))          // 绝不埋分牌
                .filter(c => !pairCardIds.has(c.id))         // 绝不埋对子中的牌
                .filter(c => getCardValue(c, trumpSuit, level) < 212) // 不埋级牌和王
                .sort((a, b) => getCardValue(a, trumpSuit, level) - getCardValue(b, trumpSuit, level));

            for (const card of safeTrumpCandidates) {
                if (toBury.length >= 8) break;
                toBury.push(card);
                usedIds.add(card.id);
            }
        }

        const buryCards = toBury.slice(0, 8);

        // 记录底牌分数到memory，用于终局判断是否需要保底策略
        // 底牌0分或5分时，拖拉机抠底/甩牌抠底概率极低，不值得损失当前利益去保底
        this.memory.bottomPoints = buryCards.reduce((s, c) => s + this._getCardScore(c), 0);

        return buryCards;
    }

    /**
     * 评估主牌强度（0~100分）
     *
     * 评估维度：
     *   1. 主牌数量：越多越好（主牌多意味着最后一轮有主牌可出的概率高）
     *   2. 大牌质量：大小王、主级对、主花色A/K等大牌
     *   3. 主牌结构：有对子/拖拉机更好（最后一轮可以出拖拉机/对子控制）
     *
     * 强度等级：
     *   >=70: 强主牌（有大小王+主牌多+有结构），可以冒险埋分牌断门
     *   40~69: 中等主牌，谨慎埋分牌
     *   <40: 弱主牌（主牌少或无大牌），不埋分牌
     *
     * @param {Array} trumps - 主牌列表
     * @param {string|null} trumpSuit
     * @param {string} level
     * @returns {number} 0~100
     */
    _evaluateTrumpStrength(trumps, trumpSuit, level) {
        if (trumps.length === 0) return 0;

        let score = 0;

        // 1. 主牌数量（满分40）
        //    典型手牌约36张，主牌约8-16张
        //    8张以下=弱，12张=中等，16张以上=强
        const trumpCount = trumps.length;

        // 2. 大牌质量（满分40）
        const bigJokers = trumps.filter(c => c.isJoker && c.rank === 'big').length;
        const smallJokers = trumps.filter(c => c.isJoker && c.rank === 'small').length;
        const mainLevelCards = trumps.filter(c => !c.isJoker && c.rank === level && c.suit === trumpSuit).length;
        const sideLevelCards = trumps.filter(c => !c.isJoker && c.rank === level && c.suit !== trumpSuit).length;

        // 大王+12，小王+8，主级牌+6，副级牌+3，上限40
        score += Math.min(bigJokers * 12 + smallJokers * 8 + mainLevelCards * 6 + sideLevelCards * 3, 40);

        // 主牌数量分（满分40）
        if (trumpCount >= 16) score += 40;
        else if (trumpCount >= 12) score += 30;
        else if (trumpCount >= 10) score += 20;
        else if (trumpCount >= 8) score += 10;
        else score += 5;

        // 3. 主牌结构（满分20）
        //    有对子/拖拉机可以在最后一轮控制出牌
        const pairs = this._findPairs(trumps, trumpSuit, level);
        const tractors = this._findTractors(trumps, trumpSuit, level);

        // 每个主牌对子+5，上限15
        score += Math.min(pairs.length * 5, 15);
        // 有拖拉机额外+5
        if (tractors.length > 0) score += 5;

        return Math.min(score, 100);
    }

    /**
     * 获取单张牌的分数值
     */
    _getCardScore(card) {
        if (card.rank === '5') return 5;
        if (card.rank === '10' || card.rank === 'K') return 10;
        return 0;
    }

    // ================================================================
    //  出牌决策 - 入口
    // ================================================================

    decidePlay(hand, gameState, trickCards) {
        const { trumpSuit, level, dealer } = gameState;
        const isDealerTeam = this._isDealerTeam(dealer);
        const position = this._getPosition(trickCards); // 1=首家, 2=次家, 3=三家, 4=四家

        // 同步庄家位置到memory，供_findThrowOpportunity等函数使用
        this.memory.dealer = dealer;

        // 同步游戏状态的甩错记录到AI记忆
        if (gameState.failedThrows && gameState.failedThrows.length > 0) {
            this.memory.failedThrows = gameState.failedThrows.map(f => f);
        }

        // 计算需要的出牌张数
        const needLen = trickCards.length > 0 ? trickCards[0].cards.length : 1;

        let result;
        if (trickCards.length === 0) {
            result = this._leadPlay(hand, trumpSuit, level, isDealerTeam, dealer);
        } else {
            result = this._followPlay(hand, trickCards, trumpSuit, level, isDealerTeam, dealer, position);
        }

        // === 安全验证：确保返回的牌合法且数量正确 ===
        if (!result || result.length === 0) {
            // 策略返回空或无效——不能掩盖问题，必须明确发出红字警报
            const fmtCard = c => c ? (c.rank === 'big' ? '大王' : c.rank === 'small' ? '小王' : c.suit + c.rank) : '?';
            const handStr = hand ? hand.map(fmtCard).join(',') : '无';
            const trickStr = (trickCards && trickCards.length > 0)
                ? trickCards.map(t => `${t.player}:${(t.cards || []).map(fmtCard).join(',')}`).join(' | ')
                : '无(首家)';
            const historyStr = (this.memory && this.memory.playedCards)
                ? this.memory.playedCards.map(fmtCard).join(',') : '无';
            console.error(
                '%c[AI策略警报] 出牌策略返回空或无效！请测试人员明确排查并解决此问题（不可忽略）。\n' +
                '--- 当前游戏状态 ---\n' +
                `手牌(${hand ? hand.length : 0}张): ${handStr}\n` +
                `桌面牌: ${trickStr}\n` +
                `主花色: ${trumpSuit || '无'} | 级别: ${level || '无'} | 庄家: ${dealer || '无'} | 是否庄家方: ${isDealerTeam} | 座位: ${position} | 需要张数: ${needLen}\n` +
                `已出牌历史: ${historyStr}`,
                'color: red; font-weight: bold; font-size: 14px; background: #fff0f0;'
            );
            // 警报后仍返回最小牌以防崩溃（但不掩盖问题，错误信息已先行打印）
            result = this._fallbackPlay(hand, needLen, trumpSuit, level);
        }

        // 过滤掉无效元素并用手中牌替换
        const handIds = new Set(hand.map(c => c.id));
        const validResult = [];
        const usedIds = new Set();
        for (const card of result) {
            if (card && handIds.has(card.id) && !usedIds.has(card.id)) {
                validResult.push(card);
                usedIds.add(card.id);
            }
        }
        // 如果有效牌不够，从手中补足
        if (validResult.length < needLen) {
            for (const card of hand) {
                if (validResult.length >= needLen) break;
                if (!usedIds.has(card.id)) {
                    validResult.push(card);
                    usedIds.add(card.id);
                }
            }
        }
        // 如果多了，截断
        result = validResult.slice(0, needLen);

        // 调试日志
        if (result && result.length > 0) {
            this._debug(`出牌: ${result.map(c => c ? (c.rank === 'big' ? '大王' : c.rank === 'small' ? '小王' : c.suit + c.rank) : '?').join(', ')}`);
        }

        return result;
    }

    /**
     * 兜底出牌策略：当正常策略失败时使用
     * 简单地出最小的牌
     */
    _fallbackPlay(hand, needLen, trumpSuit, level) {
        const sorted = this._sortByValue([...hand], trumpSuit, level);
        return sorted.slice(0, needLen);
    }

    // ================================================================
    //  首家出牌策略
    // ================================================================

    _leadPlay(hand, trumpSuit, level, isDealerTeam, dealer) {
        this.memory.trickCount++; // 新的一轮开始
        const trumps = this._sortByValue(hand.filter(c => isTrump(c, trumpSuit, level)), trumpSuit, level);
        const nonTrumps = this._sortByValue(hand.filter(c => !isTrump(c, trumpSuit, level)), trumpSuit, level);

        // 按花色分组副牌
        const suitGroups = {};
        for (const suit of [SUITS.SPADES, SUITS.HEARTS, SUITS.CLUBS, SUITS.DIAMONDS]) {
            suitGroups[suit] = this._sortByValue(
                nonTrumps.filter(c => c.suit === suit), trumpSuit, level
            );
        }

        // === 尾盘策略：最后一轮/倒数第二轮的出牌权争夺 ===
        // 尾盘核心目标：赢最后一轮 → 庄家方保底 / 闲家方抠底
        // 关键："先出的大王大"——大王留到最后一轮主动出，倒数第二轮用较大非大王牌抢出牌权
        if (this._isEndGame(hand)) {
            const endGameResult = this._endGameLeadPlay(hand, trumps, suitGroups, trumpSuit, level, isDealerTeam);
            if (endGameResult) return endGameResult;
        }

        if (isDealerTeam) {
            return this._leadAsDealer(trumps, suitGroups, trumpSuit, level, hand, dealer);
        } else {
            return this._leadAsAttacker(trumps, suitGroups, trumpSuit, level, hand);
        }
    }

    /**
     * 尾盘首家出牌策略
     *
     * 核心原则 —— "先出的大王大"：
     * 大王作为首家出牌时，跟随者的大王无法杀牌（同等级先出为大），
     * 因此大王的最大价值在于"最后一轮主动出"。
     *
     * 分阶段策略：
     *
     * 1. 最后一轮（手牌=1张）：
     *    有大王 → 出大王，"先出的大王大"，确保赢最后一轮（保底/抠底）
     *    无大王 → 出最大的牌
     *
     * 2. 倒数第二轮（手牌=2张）：
     *    绝不出单张大王！留大王给最后一轮主动出。
     *    - 有大王对 → 出大王对（这即最后一轮，对子形式出完）
     *    - 有强主牌对子 → 出对子控制（这即最后一轮）
     *    - 否则 → 出较大的非大王主牌抢出牌权，最后一轮再主动出大王
     *    赢得本轮 → 最后一轮主动出大王 → 对家被动跟随的大王无法杀牌 → 确保赢
     *    若提前出大王 → 最后一轮就失去威力
     *
     * 3. 关键尾盘（手牌3-4张）：
     *    - 不浪费大王，用拖拉机/对子/甩牌控制
     *    - 大王已全出时可用小王
     *    - 否则出较强非大王主牌
     *
     * 4. 一般尾盘（手牌5-6张）：
     *    - 优先消耗副牌，保留大王和小王给最后1-2轮
     *
     * 庄家方：保底（赢最后一轮，底牌分数不外流）
     * 闲家方：抠底（赢最后一轮，底牌分数×倍数拿走）
     */
    _endGameLeadPlay(hand, trumps, suitGroups, trumpSuit, level, isDealerTeam) {
        // 底牌≤5分时跳过保底留牌策略：
        // 不再为大王留最后一轮、不刻意保留主牌大牌给保底用
        // 交给常规出牌策略，按当前局势最优化出牌
        if (this._shouldSkipBottomProtection()) {
            return null;
        }

        const bigJokerOut = this._bigJokersPlayed();
        const bigJokers = hand.filter(c => c.isJoker && c.rank === 'big');
        const smallJokers = hand.filter(c => c.isJoker && c.rank === 'small');
        const hasBigJoker = bigJokers.length > 0;
        const hasSmallJoker = smallJokers.length > 0;

        // === 最后一轮（手牌=1张）：有大王就出大王 ===
        // "先出的大王大"：首家出大王，跟随者的大王无法杀牌
        if (hand.length === 1) {
            if (hasBigJoker) return [bigJokers[0]];
            if (hasSmallJoker) return [smallJokers[0]];
            // 没有王，出最大的牌
            const sorted = [...hand].sort((a, b) =>
                getCardValue(b, trumpSuit, level) - getCardValue(a, trumpSuit, level));
            return [sorted[0]];
        }

        // === 倒数第二轮（手牌=2张）：抢出牌权但绝不出单张大王 ===
        if (hand.length === 2) {
            // 有大王对 → 直接出对大王（这即最后一轮，对子形式确保赢）
            if (bigJokers.length === 2) return bigJokers.slice(0, 2);

            // 有小王对且大王已全出 → 小王对最大，出对子（这即最后一轮）
            if (smallJokers.length === 2 && bigJokerOut >= 2) return smallJokers.slice(0, 2);

            // 有主牌大对子（主级牌对及以上）→ 出对子控制（这即最后一轮）
            const trumpPairs = this._findPairs(trumps, trumpSuit, level);
            if (trumpPairs.length > 0) {
                const bigPair = trumpPairs[trumpPairs.length - 1];
                const bigPairVal = getCardValue(bigPair[0], trumpSuit, level);
                if (bigPairVal >= 213) return bigPair;
            }

            // 出单张抢出牌权（留大王给最后一轮）
            // 优先出小王（第二大牌，但不浪费大王）
            if (hasSmallJoker) return [smallJokers[0]];

            // 出最大的非大王主牌单张
            const nonBigJokerTrumps = trumps.filter(c => !(c.isJoker && c.rank === 'big'));
            if (nonBigJokerTrumps.length > 0) {
                return [nonBigJokerTrumps[nonBigJokerTrumps.length - 1]];
            }

            // 只有大王和副牌 → 出最大副牌，留大王给最后一轮
            const sideCards = hand.filter(c => !c.isJoker);
            if (sideCards.length > 0) {
                const sorted = sideCards.sort((a, b) =>
                    getCardValue(b, trumpSuit, level) - getCardValue(a, trumpSuit, level));
                return [sorted[0]];
            }

            // 只剩大王 → 被迫出
            return [bigJokers[0]];
        }

        // === 关键尾盘（手牌3-4张）：控制但不浪费大王 ===
        if (this._isCriticalEndGame(hand)) {
            // 1. 有主牌拖拉机 → 出拖拉机控制（尾盘拖拉机难以被杀）
            const trumpTractors = this._findTractors(trumps, trumpSuit, level);
            if (trumpTractors.length > 0) {
                const tractor = trumpTractors
                    .filter(t => t.length <= hand.length)
                    .sort((a, b) => b.length - a.length)[0];
                if (tractor) return tractor;
            }

            // 2. 有主牌大对子（主级牌对/小王对）→ 出对子控制
            const trumpPairs = this._findPairs(trumps, trumpSuit, level);
            if (trumpPairs.length > 0) {
                const bigPair = trumpPairs[trumpPairs.length - 1];
                const bigPairVal = getCardValue(bigPair[0], trumpSuit, level);
                if (bigPairVal >= 213) return bigPair;
            }

            // 3. 最后一轮可甩牌 → 甩牌（尾盘甩牌抠底倍数高）
            const throwCards = this._findThrowOpportunity(suitGroups, trumpSuit, level, hand);
            if (throwCards && throwCards.length === hand.length) return throwCards;

            // 4. 大王已全出，有小王 → 小王是最大主牌，出小王抢出牌权
            if (bigJokerOut >= 2 && hasSmallJoker) return [smallJokers[0]];

            // 5. 出最大的非大王主牌（保留大王给最后一轮）
            const nonBigJokerTrumps = trumps.filter(c => !(c.isJoker && c.rank === 'big'));
            if (nonBigJokerTrumps.length > 0) {
                return [nonBigJokerTrumps[nonBigJokerTrumps.length - 1]];
            }

            // 6. 只剩大王和副牌 → 出最大副牌
            const sideCards = hand.filter(c => !c.isJoker);
            if (sideCards.length > 0) {
                const sorted = sideCards.sort((a, b) =>
                    getCardValue(b, trumpSuit, level) - getCardValue(a, trumpSuit, level));
                return [sorted[0]];
            }

            // 7. 只剩大王 → 被迫出
            if (trumps.length > 0) return [trumps[trumps.length - 1]];
        }

        // === 一般尾盘（手牌5-6张）：开始留大牌，优先消耗副牌 ===
        // 不出大王和小王，留给最后1-2轮保底/抠底

        // 有甩牌机会且含分 → 可以甩（提前跑分，避免最后被抠）
        const throwCards = this._findThrowOpportunity(suitGroups, trumpSuit, level, hand);
        if (throwCards) return throwCards;

        // 出副牌小牌消耗，保留主牌大牌
        let longestSuit = null;
        let longestLen = 0;
        for (const suit of Object.keys(suitGroups)) {
            if (suitGroups[suit].length > longestLen) {
                longestLen = suitGroups[suit].length;
                longestSuit = suit;
            }
        }
        if (longestSuit && longestLen > 0) {
            return [suitGroups[longestSuit][0]];
        }

        // 只有主牌了，出小主牌（不出大王/小王，留给关键轮）
        const smallTrumps = trumps.filter(c =>
            !(c.isJoker && c.rank === 'big') && !(c.isJoker && c.rank === 'small')
        );
        if (smallTrumps.length > 0) return [smallTrumps[0]];

        // 实在没有小主牌，被迫出小王（大王最后留）
        const nonBigTrumps = trumps.filter(c => !(c.isJoker && c.rank === 'big'));
        if (nonBigTrumps.length > 0) return [nonBigTrumps[0]];
        if (trumps.length > 0) return [trumps[0]];

        return null; // 回退到常规策略
    }

    /**
     * 庄家队首家出牌策略
     * 目标：出副牌大牌（A优先），让队友跑分
     *
     * 核心原则（基于记忆，不赌牌）：
     * 1. 只有确认A是最大的牌时才出A（A永远可以出，A就是最大的副牌）
     * 2. 不出K来赌队友有A——只有当记忆确认两个A都出过了，K才是最大的，才出K
     * 3. 同理，KKAA都出过了，Q才是最大的，才出Q
     * 4. 对手已断门的花色，即使有A也不出（会被主牌杀）
     * 5. 如果没有可以安全出的大牌，出最长套的小牌消耗对手主牌
     */
    _leadAsDealer(trumps, suitGroups, trumpSuit, level, hand, dealer) {
        // 使用统一的强势牌评估系统
        return this._leadWithStrength(trumps, suitGroups, trumpSuit, level, hand, dealer);
    }

    /**
     * 队友开局策略：如果庄家已显示某花色断门，走该花色单张让庄家杀牌
     *
     * 场景：队友上手后，通过记忆判断庄家断了哪门花色，
     * 然后走该花色单张让庄家用主牌毙杀，把出牌权送还给庄家。
     * 这样控场就能轻轻松松过渡到中盘。
     *
     * @returns {Array|null} 要出的牌，或null
     */
    _leadDealerVoidSuit(suitGroups, dealer, trumpSuit, level) {
        // 检查庄家断门的花色
        const voidSuits = [];
        for (const suit of [SUITS.SPADES, SUITS.HEARTS, SUITS.CLUBS, SUITS.DIAMONDS]) {
            if (this._isPlayerVoid(dealer, suit) && suitGroups[suit] && suitGroups[suit].length > 0) {
                // 庄家断了该花色，且队友手上有该花色牌
                voidSuits.push(suit);
            }
        }

        if (voidSuits.length === 0) return null;

        // 优先走短套（队友手上该花色牌越少，说明越危险，尽快走掉）
        voidSuits.sort((a, b) => suitGroups[a].length - suitGroups[b].length);

        const targetSuit = voidSuits[0];
        const cards = suitGroups[targetSuit];

        // 走单张（给庄家杀牌，保留对子等其他形式）
        // 优先走最小的非分牌（不要让庄家杀牌时把分牌也杀走）
        const nonPointCards = cards.filter(c => !this._isPointCard(c));
        if (nonPointCards.length > 0) return [nonPointCards[0]];

        // 全是分牌，走最小的
        return [cards[0]];
    }

    /**
     * 评估单张副牌的强势度
     * 100 = 此牌在当前局势下是这门花色最大单张
     * 
     * @param {Object} card - 要评估的牌
     * @param {string} trumpSuit - 主花色
     * @param {string} level - 级别
     * @returns {number} 强势度分数 (0-100)
     */
    _evaluateSingleStrength(card, trumpSuit, level) {
        if (card.isJoker || isTrump(card, trumpSuit, level)) return 0;
        
        const suit = card.suit;
        const rank = card.rank;
        
        // 统计该花色各点数已出数量（排除级牌，因为级牌是主牌）
        const count = (r) => this.memory.playedCards.filter(c => 
            c.suit === suit && c.rank === r && !isTrump(c, trumpSuit, level)
        ).length;
        
        if (rank === 'A') return 100;                    // 永远是最大副牌
        if (rank === 'K' && count('A') >= 2) return 95;  // AA出完，K最大
        if (rank === 'Q' && count('A') >= 2 && count('K') >= 2) return 90;
        if (rank === 'J' && count('A') >= 2 && count('K') >= 2 && count('Q') >= 2) return 85;
        if (rank === '10' && count('A') >= 2 && count('K') >= 2 && count('Q') >= 2 && count('J') >= 2) return 80;
        
        return 0; // 不够强势，走送权策略
    }

    /**
     * 评估对子的强势度
     * 
     * @param {Array} pair - 对子数组（两张牌）
     * @param {string} trumpSuit - 主花色
     * @param {string} level - 级别
     * @returns {number} 强势度分数 (0-100)
     */
    _evaluatePairStrength(pair, trumpSuit, level) {
        const suit = pair[0].suit;
        const rank = pair[0].rank;
        const count = (r) => this.memory.playedCards.filter(c => 
            c.suit === suit && c.rank === r && !isTrump(c, trumpSuit, level)
        ).length;
        
        if (rank === 'A') return 100;
        
        // K对：出过1张A即可（剩1张A无法成对）
        if (rank === 'K' && count('A') >= 1) return 95;
        
        // Q对：A和K各出过至少1张
        if (rank === 'Q' && count('A') >= 1 && count('K') >= 1) {
            if (count('A') >= 2 && count('K') >= 2) return 95; // 都出完了，必最大
            return 85; // 外面最多1A1K，成对概率极低
        }
        
        // J对：大牌出过较多
        if (rank === 'J' && count('A') + count('K') + count('Q') >= 3) {
            if (count('A') >= 2 && count('K') >= 2 && count('Q') >= 2) return 90;
            return 75;
        }
        
        // 推断性强势：出过大对子测试后，对手可能没对子
        if (this._hasTestedBigPairInSuit(suit, trumpSuit, level)) {
            // 小对子也可能是最大的，rank越大（越接近A）强势度越高
            const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
            return 40 + RANKS.indexOf(rank) * 2;
        }
        
        return 0;
    }

    /**
     * 闲家队首家出牌策略
     * 目标：出小牌过渡，或出长套消耗庄家主牌，伺机抢分
     *
     * 核心原则（基于记忆，不赌牌）：
     * 1. 有A先出A抢分（A永远可以出，是最大副牌）
     * 2. 不出K赌队友有A——只有记忆确认A都出过了才出K
     * 3. 对手已断门的花色不出大牌（会被杀）
     * 4. 没有大牌可出时，出最长套小牌消耗对手主牌
     */
    _leadAsAttacker(trumps, suitGroups, trumpSuit, level, hand) {
        // 使用统一的强势牌评估系统（传入null作为dealer，因为attacker不是庄家队）
        return this._leadWithStrength(trumps, suitGroups, trumpSuit, level, hand, null);
    }

    /**
     * 首家出副牌对子的决策
     *
     * 确定性出牌（只要对手没明确断门）：
     *   A对 → 永远出（A是最大副牌，不可能被副牌对子压）
     *   K对 → 出过1张A就出（剩1张A无法成对，K对最大）
     *
     * 概率性出牌（对子相对稀有，大牌对子被杀概率低）：
     *   Q对 → 80%概率出
     *   J对 → 70%概率出
     *   10对 → 50%概率出（10是分牌，被杀丢分，概率更低）
     *
     * 推断性出牌：
     *   如果之前出过大对子，对手跟牌时没有出对子（跟了单牌），
     *   说明对手可能没对子了，此时小对子也是大的，可以出。
     *
     * @returns {Array|null} 要出的对子，或null（不出了对子）
     */
    _decideLeadPair(suitGroups, trumpSuit, level) {
        // 概率表：不同点数对子在无明确信号时的出击概率
        const PROB = { 'Q': 0.8, 'J': 0.7, '10': 0.5 };

        // 收集所有花色的对子，按大小排序
        const allPairs = [];
        for (const suit of Object.keys(suitGroups)) {
            const pairs = this._findPairs(suitGroups[suit], trumpSuit, level);
            for (const pair of pairs) {
                const rank = pair[0].rank;
                const value = getCardValue(pair[0], trumpSuit, level);
                const opp1Void = this._isPlayerVoid('left', suit);
                const opp2Void = this._isPlayerVoid('right', suit);
                const oppVoid = opp1Void && opp2Void;
                allPairs.push({ pair, rank, suit, value, oppVoid });
            }
        }
        allPairs.sort((a, b) => b.value - a.value); // 大到小

        // 第一轮：确定性出牌——A对、K对
        for (const item of allPairs) {
            if (item.oppVoid) continue; // 对手都断了，不出

            if (item.rank === 'A') {
                // A对：拆单张利于队友跑分，出对子逼对手对子
                // 两种策略各50%概率，增加AI不可预测性
                if (Math.random() < 0.5) {
                    return item.pair; // 出对子，逼对手对子
                } else {
                    return [item.pair[0]]; // 拆单张，利于队友跑10跑5
                }
            }
            if (item.rank === 'K') {
                // K对：出过1张A就出
                const aPlayed = this.memory.playedCards.filter(c =>
                    c.suit === item.suit && c.rank === 'A'
                ).length;
                if (aPlayed >= 1) {
                    return item.pair;
                }
            }
        }

        // 第二轮：概率性出牌——Q对、J对、10对
        for (const item of allPairs) {
            if (item.oppVoid) continue;

            const prob = PROB[item.rank];
            if (prob !== undefined) {
                // 检查是否有更高级的牌还没出完
                // Q对：如果A/K还没出完，被压的概率更高，降低出牌概率
                let adjustedProb = prob;
                if (item.rank === 'Q') {
                    const aPlayed = this.memory.playedCards.filter(c => c.suit === item.suit && c.rank === 'A').length;
                    const kPlayed = this.memory.playedCards.filter(c => c.suit === item.suit && c.rank === 'K').length;
                    // A/K出得越多，Q越安全
                    if (aPlayed >= 2 && kPlayed >= 2) adjustedProb = 1.0; // 确定性出
                    else if (aPlayed >= 1 || kPlayed >= 1) adjustedProb = Math.min(prob + 0.15, 0.95);
                }
                if (item.rank === 'J') {
                    const aPlayed = this.memory.playedCards.filter(c => c.suit === item.suit && c.rank === 'A').length;
                    const kPlayed = this.memory.playedCards.filter(c => c.suit === item.suit && c.rank === 'K').length;
                    const qPlayed = this.memory.playedCards.filter(c => c.suit === item.suit && c.rank === 'Q').length;
                    if (aPlayed >= 2 && kPlayed >= 2 && qPlayed >= 2) adjustedProb = 1.0;
                    else if (aPlayed + kPlayed + qPlayed >= 3) adjustedProb = Math.min(prob + 0.15, 0.9);
                }

                if (Math.random() < adjustedProb) {
                    return item.pair;
                }
            }
        }

        // 第三轮：推断性出牌——之前出过大对子测试过，对手没跟对子
        // 说明对手可能没对子了，小对子也是大的
        for (const item of allPairs) {
            if (item.oppVoid) continue;
            // 跳过已经处理过的大牌对子
            if (['A', 'K', 'Q', 'J', '10'].includes(item.rank)) continue;

            // 判断是否之前出过该花色的大对子，且对手跟牌时没出对子
            const hasTestedBigPair = this._hasTestedBigPairInSuit(item.suit, trumpSuit, level);
            if (hasTestedBigPair) {
                // 对手没跟对子，小对子也是大的
                return item.pair;
            }
        }

        return null;
    }

    /**
     * 判断之前是否出过某花色的大对子（A对/K对/Q对），
     * 且对手跟牌时没出对子（说明对手可能没对子了）
     */
    _hasTestedBigPairInSuit(suit, trumpSuit, level) {
        // 检查记忆中是否有该花色的大对子出过
        // playedCards是平铺的，需要按轮次分析
        // 简化判断：如果该花色的A/K/Q出过2张以上，说明可能出过对子
        const bigRanks = ['A', 'K', 'Q'];
        for (const rank of bigRanks) {
            const played = this.memory.playedCards.filter(c =>
                c.suit === suit && c.rank === rank && !isTrump(c, trumpSuit, level)
            );
            if (played.length >= 2) {
                return true;
            }
        }
        return false;
    }

    /**
     * 判断是否在任意花色中出过大对子测试
     * 用于开局策略：如果庄家没走过大对子，不知道外面是否有对子，
     * 走小单主牌比冒险走小对子更安全
     */
    _hasTestedBigPairInAnySuit(trumpSuit, level) {
        for (const suit of [SUITS.SPADES, SUITS.HEARTS, SUITS.CLUBS, SUITS.DIAMONDS]) {
            if (this._hasTestedBigPairInSuit(suit, trumpSuit, level)) {
                return true;
            }
        }
        return false;
    }

    /**
     * 送权降级路径（无强势牌时）
     * 
     * @param {Array} trumps - 主牌数组
     * @param {Object} suitGroups - 按花色分组的副牌
     * @param {string} trumpSuit - 主花色
     * @param {string} level - 级别
     * @param {Array} hand - 手牌
     * @param {boolean} isDealer - 是否是庄家
     * @param {boolean} isTeammate - 是否是庄家队友
     * @param {boolean} isDealerTeam - 是否是庄家队
     * @returns {Array} 要出的牌
     */
    _leadGiveControl(trumps, suitGroups, trumpSuit, level, hand, isDealer, isTeammate, isDealerTeam) {
        // 1. 庄家自己：出小单张主牌送权
        // 前提：主牌不能太少，否则队友抢不到权
        if (isDealer && trumps.length >= 3) {
            const smallTrump = this._findBestSmallTrump(trumps, trumpSuit, level);
            if (smallTrump) return [smallTrump];
        }
        
        // 2. 队友：如果庄家没断门可送，也出小单张主牌
        // （等待庄家送权给自己，或自己抢到后出强势牌）
        if (isTeammate && trumps.length >= 3) {
            const smallTrump = this._findBestSmallTrump(trumps, trumpSuit, level);
            if (smallTrump) return [smallTrump];
        }
        
        // 3. 闲家队：出小张单主过渡，让本方队友决定是否拿走出牌权
        //    （原策略出最长套最小牌必然送给庄家方杀牌，反而帮庄家消耗小主；
        //     改为出小单张主牌过渡——本方队友可凭更大主牌决定是否抢权，
        //     而非必然把出牌权交给庄家方。主牌过少时仍走兜底出副牌。）
        if (!isDealerTeam) {
            if (trumps.length >= 2) {
                const smallTrump = this._findBestSmallTrump(trumps, trumpSuit, level);
                if (smallTrump) return [smallTrump];
            }
        }
        
        // 4. 兜底：出最长套的最小牌（消耗副牌）
        let longestSuit = null, longestLen = 0;
        for (const suit of Object.keys(suitGroups)) {
            if (suitGroups[suit].length > longestLen) {
                longestLen = suitGroups[suit].length;
                longestSuit = suit;
            }
        }
        if (longestSuit && longestLen > 0) {
            return [suitGroups[longestSuit][0]];
        }
        
        // 5. 只有主牌了
        if (trumps.length > 0) return [trumps[0]];
        return [hand[0]];
    }

    /**
     * 统一的强势牌出牌逻辑
     * 核心思路：给每张可出的牌/牌型打一个强势度分数（0~100），分数达到阈值就确定性地出
     * 
     * @param {Array} trumps - 主牌数组
     * @param {Object} suitGroups - 按花色分组的副牌
     * @param {string} trumpSuit - 主花色
     * @param {string} level - 级别
     * @param {Array} hand - 手牌
     * @param {string} dealer - 庄家位置（null表示闲家队）
     * @returns {Array} 要出的牌
     */
    _leadWithStrength(trumps, suitGroups, trumpSuit, level, hand, dealer) {
        const isDealerTeam = dealer !== null && this._isDealerTeam(dealer);
        const isDealer = dealer !== null && this.position === dealer;
        const isTeammate = dealer !== null && !isDealer;
        
        // === 队友：走庄家断门花色（让庄家毙杀回收权）===
        // 不限于开局，只要记忆明确就可以
        if (isTeammate) {
            const voidSuitLead = this._leadDealerVoidSuit(suitGroups, dealer, trumpSuit, level);
            if (voidSuitLead) return voidSuitLead;
        }
        
        // === 收集所有强势出牌选项 ===
        const plays = [];
        
        // 3a. 强势单张（≥85分）
        for (const suit of Object.keys(suitGroups)) {
            for (const card of suitGroups[suit]) {
                const s = this._evaluateSingleStrength(card, trumpSuit, level);
                if (s >= 85) {
                    plays.push({ cards: [card], strength: s, type: 'single', suit, suitLen: suitGroups[suit].length });
                }
            }
        }
        
        // 3b. 强势对子（≥70分）
        for (const suit of Object.keys(suitGroups)) {
            const pairs = this._findPairs(suitGroups[suit], trumpSuit, level);
            for (const pair of pairs) {
                const s = this._evaluatePairStrength(pair, trumpSuit, level);
                if (s >= 70) {
                    plays.push({ cards: pair, strength: s, type: 'pair', suit, suitLen: suitGroups[suit].length });
                }
            }
        }
        
        // 3c. 拖拉机（永远强势）
        for (const suit of Object.keys(suitGroups)) {
            const tractor = this._findBestTractor(suitGroups[suit], trumpSuit, level);
            if (tractor && tractor.length >= 4) {
                plays.push({ cards: tractor, strength: 100, type: 'tractor', suit, suitLen: suitGroups[suit].length });
            }
        }
        
        // 3d. 甩牌
        const throwCards = this._findThrowOpportunity(suitGroups, trumpSuit, level, hand);
        if (throwCards) {
            const throwSuit = throwCards[0].suit;
            plays.push({ 
                cards: throwCards, strength: 92, type: 'throw', 
                suit: throwSuit, suitLen: (suitGroups[throwSuit] || []).length 
            });
        }
        
        // === 出最强的一套 ===
        if (plays.length > 0) {
            plays.sort((a, b) => {
                // 类型优先级：tractor > throw > pair > single
                const order = { tractor: 4, throw: 3, pair: 2, single: 1 };
                if (order[a.type] !== order[b.type]) return order[b.type] - order[a.type];
                // 同类型比强势度
                if (b.strength !== a.strength) return b.strength - a.strength;
                // 同强势度：短套优先（先处理危险花色，避免断门后被杀）
                return a.suitLen - b.suitLen;
            });
            return plays[0].cards;
        }
        
        // === 没有强势牌 → 明确的送权策略 ===
        return this._leadGiveControl(trumps, suitGroups, trumpSuit, level, hand, isDealer, isTeammate, isDealerTeam);
    }

    /**
     * 寻找甩牌机会
     *
     * 甩牌条件：某门副牌中，手上的牌无论单双，都是市面上该门副牌里最大的。
     * 即：比手牌中任何一张大的同花色牌都已经出过了。
     *
     * 甩牌的优势：
     *   - 对手只能跟小牌或垫牌，很难杀（需要全主牌+足够对子）
     *   - 甩牌是拖拉机之外抠底出大分数的最常见情形
     *   - 可以一次性出掉多张牌
     *
     * 策略：
     *   1. 遍历每个副牌花色，检查是否所有牌都是该门最大的
     *   2. 优先甩张数多的（消耗更多牌，减少手牌）
     *   3. 优先甩含分牌的（跑分）
     *
     * @returns {Array|null} 要甩的牌数组，或null
     */
    _findThrowOpportunity(suitGroups, trumpSuit, level, hand) {
        const throwOpportunities = [];

        // 1. 检查副牌甩牌机会
        for (const suit of Object.keys(suitGroups)) {
            const cards = suitGroups[suit];
            if (cards.length < 2) continue; // 1张牌不算甩牌（就是单张）

            // 检查该花色的所有牌是否都是市面上最大的
            if (isThrowValid(cards, trumpSuit, level, this.memory.playedCards)) {
                // 检查是否曾经甩错过该牌型
                if (this._hasFailedThrow(cards, trumpSuit, level)) continue;

                // 计算甩牌的价值（含分牌越多越好，张数越多越好）
                const pointValue = cards.reduce((s, c) => s + this._getCardScore(c), 0);
                throwOpportunities.push({
                    cards: cards,
                    suit: suit,
                    count: cards.length,
                    pointValue: pointValue
                });
            }
        }

        // 2. 检查主牌甩牌机会（主牌甩牌仅限两种情况）
        //    a) 闲家最后一手主牌合法全甩，获得抠底高翻倍的机会
        //    b) 庄家控场清空了其他家的主牌，自己手中全是主牌，快速结束本局
        //    底牌≤5分时跳过情况b：拖拉机抠底/甩牌抠底概率极低，不值得为此快速结束
        const trumps = hand.filter(c => isTrump(c, trumpSuit, level));
        if (trumps.length >= 2 && isThrowValid(trumps, trumpSuit, level, this.memory.playedCards)) {
            if (!this._hasFailedThrow(trumps, trumpSuit, level)) {
                // 判断是否满足主牌甩牌条件
                const isLastHand = hand.length === trumps.length; // 手中全是主牌
                const isEndgame = hand.length <= 6; // 尾盘阶段
                const isDealerTeam = this.memory.dealer ? this._isDealerTeam(this.memory.dealer) : false;

                // 情况a：最后一手全主牌（无论庄闲都允许，这是自然出牌）
                // 情况b：庄家尾盘控场全主牌快速结束（底牌≤5分时跳过，不值得保底）
                const skipDealerThrow = this._shouldSkipBottomProtection();
                if (isLastHand || (!skipDealerThrow && isDealerTeam && isEndgame && trumps.length >= hand.length)) {
                    const pointValue = trumps.reduce((s, c) => s + this._getCardScore(c), 0);
                    // 主牌甩牌价值更高（毙杀难度大）
                    throwOpportunities.push({
                        cards: trumps,
                        suit: 'trump',
                        count: trumps.length,
                        pointValue: pointValue + 50 // 主牌甩牌额外加分
                    });
                }
            }
        }

        if (throwOpportunities.length === 0) return null;

        // 优先甩张数多 + 含分牌的
        throwOpportunities.sort((a, b) => {
            // 先按张数降序（多张优先）
            if (b.count !== a.count) return b.count - a.count;
            // 再按分牌降序
            return b.pointValue - a.pointValue;
        });

        // 截图建议：多个策略评分相等时，引入随机选择
        const top = throwOpportunities.filter(o =>
            o.count === throwOpportunities[0].count &&
            o.pointValue === throwOpportunities[0].pointValue
        );
        if (top.length > 1) {
            return this._pickRandom(top).cards;
        }

        return throwOpportunities[0].cards;
    }

    /**
     * 概率性出小单主牌决策
     *
     * 理念：出牌本质是概率问题。副牌A≈100%赢，大对子有较高概率不被杀。
     * 当没有高概率牌可出时，小单主牌出手也有约60%的赢面，因为：
     *   1. 对手可能主牌不够长，跟不起
     *   2. 对手可能不愿浪费大主牌来跟一张小主牌
     *   3. 出小主牌消耗对手主牌资源，为后续大牌铺路
     *
     * 前提条件：
     *   - 有主牌可出
     *   - 不是最后手段（手牌还比较多时才考虑）
     *   - 60%概率出击（留40%回退到出副牌小牌消耗）
     *
     * @returns {Array|null} [小主牌] 或 null（不出主牌）
     */
    _decideSmallTrumpLead(trumps, trumpSuit, level) {
        if (!trumps || trumps.length === 0) return null;

        // 找最小的主牌（不含王、不含主级牌这种大牌）
        // 主花色的小牌（如主2、主3等）最适合做小主牌出手
        const smallTrumps = trumps.filter(c => {
            const val = getCardValue(c, trumpSuit, level);
            // 不出王（太珍贵）、不出主级牌（213）、不出副级牌（212）
            // 只出主花色普通小牌（200~205左右）
            return val >= 200 && val <= 208;
        });

        if (smallTrumps.length === 0) {
            // 没有小主花色牌，看有没有其他较小主牌
            // 但不出王和主级牌
            const otherSmallTrumps = trumps.filter(c => {
                const val = getCardValue(c, trumpSuit, level);
                return val < 212; // 不含级牌和王
            });
            if (otherSmallTrumps.length === 0) return null;
            // 60%概率出最小的小主牌
            if (Math.random() < 0.6) {
                return [otherSmallTrumps[0]];
            }
            return null;
        }

        // 60%概率出最小的小主牌
        if (Math.random() < 0.6) {
            return [smallTrumps[0]];
        }

        return null;
    }

    /**
     * 找到最小的合适主牌用于"让队友上手"策略
     * 与 _decideSmallTrumpLead 不同，这个方法总是返回结果（非概率性）
     * 用于庄家开局策略：走完必胜牌后，走小单主牌让队友上手
     */
    _findBestSmallTrump(trumps, trumpSuit, level) {
        if (!trumps || trumps.length === 0) return null;

        // 优先找主花色普通小牌（value 200~208）
        const smallTrumps = trumps.filter(c => {
            const val = getCardValue(c, trumpSuit, level);
            return val >= 200 && val <= 208;
        });
        if (smallTrumps.length > 0) return smallTrumps[0];

        // 没有主花色小牌，看有没有其他较小主牌（不含级牌和王）
        const otherSmallTrumps = trumps.filter(c => {
            const val = getCardValue(c, trumpSuit, level);
            return val < 212;
        });
        if (otherSmallTrumps.length > 0) return otherSmallTrumps[0];

        // 实在没有小主牌，出最小的主牌
        return trumps[0];
    }

    // ================================================================
    //  跟牌策略
    // ================================================================

    _followPlay(hand, trickCards, trumpSuit, level, isDealerTeam, dealer, position) {
        const leadCards = trickCards[0].cards;
        const leadPattern = getCardPattern(leadCards, trumpSuit, level, this.memory.playedCards);
        const leadSuit = getLeadSuit(leadCards, trumpSuit, level);
        const leadPlayer = trickCards[0].player;

        // === 追踪队友首发出小主牌的次数 ===
        // 用户策略："首家队友第一次出小单主牌→用大小王抢权；第二次开始→仅需拦截防跑分"
        if (this._isTeammate(leadPlayer) && leadSuit === null &&
            this._isSmallTrumpCard(leadCards, trumpSuit, level) &&
            this.memory.lastSmallTrumpLeadTrick !== this.memory.trickCount) {
            this.memory.teammateSmallTrumpLeads++;
            this.memory.lastSmallTrumpLeadTrick = this.memory.trickCount;
        }

        // 判断当前谁在赢
        const currentWinner = getTrickWinner(trickCards, trumpSuit, level, this.memory.playedCards);
        const iAmWinning = currentWinner && this._isTeammate(currentWinner.player);

        const trumps = this._sortByValue(hand.filter(c => isTrump(c, trumpSuit, level)), trumpSuit, level);

        // 计算当前桌面上的分数
        const trickScore = getCardScore(trickCards.flatMap(t => t.cards));

        // 判断是否是最后一家（第4个出牌）
        const isLastPlayer = trickCards.length === 3;

        // 位置感知策略调整（基于tractor_AI文档）
        // position: 2=次家(对手，灵活), 3=三家(队友最后一手), 4=四家(决定胜负)
        // 次家(2)更灵活，可以保守跟牌等队友(4)补救
        // 三家(3)是本方最后一手，需要考虑是否跑分或抢权
        // 四家(4)决定胜负，出牌权争夺最关键

        // 终局阶段：考虑抠底保底策略
        // AI文档："应该在倒数剩5张牌开始，战略性考虑抠底保底的策略"
        // 底牌≤5分时跳过保底策略：拖拉机抠底/甩牌抠底概率极低，不值得损失当前利益
        const skipBottomStrategy = this._shouldSkipBottomProtection();
        const isBottomPhase = this._isBottomGamePhase(hand);
        const isLastHand = hand.length === leadPattern.length;

        // === 终局策略：最后一手牌的保底/抠底 ===
        // 最后一手牌的赢家获得底牌分数（倍数由牌型决定）
        // 庄家方必须赢最后一手保底，闲家方要赢最后一手抠底
        // 底牌≤5分时：函数内部会跳过保底杀牌，但保留队友在赢时跑分的逻辑
        if (isLastHand) {
            const bottomResult = this._bottomPhaseLastHand(
                hand, trumps, leadPattern, leadSuit, trickCards, iAmWinning,
                trickScore, trumpSuit, level, isDealerTeam, isLastPlayer
            );
            if (bottomResult) return bottomResult;
        }

        // === 终局策略：倒数几手的出牌权争夺 ===
        // 庄家方：不惜代价赢牌，防止闲家拿到最后一手出牌权
        // 闲家方：用大王/小王抢出牌权，为最后一手多张牌抠底做准备
        // 底牌≤5分时跳过：不值得为此消耗主牌大牌
        if (isBottomPhase && !iAmWinning && !isLastHand && !skipBottomStrategy) {
            const bottomResult = this._bottomPhaseProtect(
                hand, trumps, leadPattern, leadSuit, trickCards, trickScore,
                trumpSuit, level, isDealerTeam, isLastPlayer
            );
            if (bottomResult) return bottomResult;
        }

        // === 甩牌的特殊跟牌处理 ===
        // 甩牌跟牌规则：
        //   - 必须跟数量相同的牌
        //   - 有同花色的必须跟（有多少跟多少），不够的垫任何牌
        //   - 要杀：必须断门 + 全主牌 + 对子数≥甩牌对子数
        if (leadPattern.type === 'throw') {
            return this._followThrow(hand, leadPattern, leadSuit, trickCards, iAmWinning, trickScore, trumpSuit, level, isLastPlayer, trumps);
        }

        // === 首家出的是主牌 ===
        if (leadSuit === null) {
            return this._followTrump(trumps, hand, leadPattern, iAmWinning, trickScore, trumpSuit, level, trickCards, isLastPlayer, leadPlayer, dealer, position);
        }

        // === 首家出的是副牌花色 ===
        const leadSuitCards = this._sortByValue(
            hand.filter(c => !c.isJoker && c.suit === leadSuit && !isTrump(c, trumpSuit, level)),
            trumpSuit, level
        );

        const hasLeadSuit = leadSuitCards.length > 0;

        if (hasLeadSuit) {
            return this._followSuit(leadSuitCards, leadPattern, iAmWinning, trickScore, trumpSuit, level, trickCards, hand, isDealerTeam, isLastPlayer, leadSuit, position, leadPlayer);
        }

        // 没有首家花色 → 杀主或垫牌
        return this._followNoSuit(trumps, hand, leadPattern, trickCards, iAmWinning, trickScore, trumpSuit, level, isDealerTeam, isLastPlayer, leadSuit, position, leadPlayer);
    }

    /**
     * 跟主牌
     *
     * 位置感知策略（tractor_AI文档）：
     *   position 2（次家）：对手，灵活，队友四家可补救
     *   position 3（三家）：队友（对门）是首家，本方最后一手，胜负关系大
     *     - 队友赢且二家没杀 → 跑分（10>K>5），无分跟小牌
     *     - 二家杀了 → 尝试用更大主牌反杀，不能反杀则跟小牌
     *   position 4（四家）：决定胜负，出牌权争夺最关键
     */
    _followTrump(trumps, hand, leadPattern, iAmWinning, trickScore, trumpSuit, level, trickCards, isLastPlayer, leadPlayer, dealer, position) {
        const needLen = leadPattern.length;

        // 主牌不够，尽量出主牌，不够的用副牌补足
        if (trumps.length < needLen) {
            const result = [...trumps];
            const used = new Set(trumps.map(c => c.id));
            const nonTrumps = this._sortByValue(
                hand.filter(c => !isTrump(c, trumpSuit, level) && !used.has(c.id)), trumpSuit, level
            );

            // 补牌优先用最小的非分牌，最后用分牌
            const safeCards = nonTrumps.filter(c => !this._isPointCard(c));
            const pointCards = nonTrumps.filter(c => this._isPointCard(c));

            for (const card of safeCards) {
                if (result.length >= needLen) break;
                result.push(card);
                used.add(card.id);
            }
            for (const card of pointCards) {
                if (result.length >= needLen) break;
                result.push(card);
                used.add(card.id);
            }
            return result.slice(0, needLen);
        }

        if (leadPattern.type === 'single') {
            const winner = getTrickWinner(trickCards, trumpSuit, level, this.memory.playedCards);
            const winnerValue = getCardValue(winner.cards[0], trumpSuit, level);
            const winnerIsTeammate = this._isTeammate(winner.player);
            const isLastTrick = hand.length === leadPattern.length;
            const leadIsSmallTrump = this._isSmallTrumpCard(trickCards[0].cards, trumpSuit, level);
            const leadIsJoker = trickCards[0].cards[0].isJoker;

            // ================================================================
            // 次家（position=2）：对手是首家，队友在四家可补救，出牌灵活
            // AI文档："次家出牌较为灵活，因为第四个出牌的队友还能有扭转乾坤的可能性"
            // ================================================================
            if (position === 2) {
                if (winnerIsTeammate) {
                    // 首家是对手，但队友不可能在赢（次家时只有首家出过牌）
                    // 此分支不该到达，保险处理
                    return [trumps[0]];
                }
                // 首家（对手）在赢
                // 对手走小主牌 → 可以跟小主牌交给四家队友管理，或直接抢权
                // 对手走大主牌 → 跟小主牌保留实力
                if (leadIsSmallTrump) {
                    // 对手走小主牌，自己可以跟非分小主牌交给队友
                    // 也可以直接上大牌抢权（如果有A/级牌等强势主牌）
                    const nonPointTrumps = trumps.filter(c => !this._isPointCard(c));
                    if (nonPointTrumps.length > 0) {
                        return [nonPointTrumps[0]]; // 跟最小非分主牌
                    }
                    return [trumps[0]];
                }
                // 对手走大主牌或王 → 跟最小主牌
                return [trumps[0]];
            }

            // ================================================================
            // 三家（position=3）：对门（队友）是首家，本方最后一手
            // AI文档："自己走的牌是本方最后一手，本轮胜负自己可能有较大关系"
            // ================================================================
            if (position === 3 && this._isTeammate(leadPlayer)) {
                // 首家是队友，关键区分：队友出的是小主牌 vs 大主牌 vs 王

                if (leadIsSmallTrump) {
                    const leadCount = this.memory.teammateSmallTrumpLeads;

                    // ★ 第一次出小主牌：用大小王等级强牌抢出牌权
                    // AI文档："若首家第一次出小单主牌，需用大小王等级的强牌努力争取出牌权。争不过那没办法。"
                    if (leadCount <= 1) {
                        const grabCard = this._grabControlCard(trumps, winnerValue, trumpSuit, level, isLastTrick, hand);
                        if (grabCard) {
                            const label = grabCard.isJoker
                                ? (grabCard.rank === 'big' ? '大王' : '小王')
                                : (grabCard.rank === level ? '级牌' : '大主牌');
                            this._debug(`三家：队友首次出小主牌，用${label}抢出牌权`);
                            return [grabCard];
                        }
                        this._debug(`三家：队友首次出小主牌，争不过，跟最小主牌`);
                        return [trumps[0]];
                    }

                    // ★ 第二次开始出小主牌：仅需拦截思路，确保对手方不跑分
                    // 用户策略："首家队友第二次开始出小单主牌，仅需用拦截的思路确保对手方不跑分即可"
                    // 不再浪费大小王，用级牌/中级主牌拦截即可
                    const interceptCard = this._findTrumpInterceptCard(
                        trumps, winnerValue, trumpSuit, level, isLastTrick, hand);
                    if (interceptCard) {
                        this._debug(`三家：队友后续出小主牌，拦截防跑分`);
                        return [interceptCard];
                    }
                    // 拦截不了 → 跟最小主牌
                    this._debug(`三家：队友后续出小主牌，拦不住，跟最小主牌`);
                    return [trumps[0]];
                }

                // 队友出的是大主牌或王
                if (winnerIsTeammate) {
                    // 二家没杀，队友在赢
                    // 除非队友首发的是绝对大牌（如大王，场上无更大主牌），否则需结合第四家实力
                    // 确认队友真能赢才加分；无法确定四家是否反超时跟小牌或小分，保留大牌大分。
                    const outstandingBigger = this._countOutstandingBiggerTrumps(
                        winnerValue, trumpSuit, level, hand, trickCards);
                    if (outstandingBigger === 0) {
                        // 确认队友稳赢（大王，或更大的主牌均已出尽）→ 跑分
                        // AI文档："加分数跑分，优先跑10，其次跑K，最次跑5"
                        const runCard = this._getRunScoreCard(trumps);
                        if (runCard) {
                            this._debug(`三家：队友大主牌稳赢（无更大主牌在外），跑主牌分${runCard.rank}`);
                            return [runCard];
                        }
                        // 无分 → 跟最小主牌
                        return [trumps[0]];
                    }
                    // 无法确定四家能否反超 → 跟小牌或小分（保留大牌大分）
                    this._debug(`三家：队友大主牌但四家可能反超，跟小牌/小分`);
                    const nonScoreTrumps = trumps.filter(c => !this._isPointCard(c));
                    if (nonScoreTrumps.length > 0) return [nonScoreTrumps[0]];
                    const discardScore = this._getDiscardScoreCard(trumps);
                    return [discardScore || trumps[0]];
                }

                // 二家杀了（对手在赢）→ 应尽力压制二家
                // 除非同时满足：①二家早已拿过出牌权且基本无强势牌；②四家明确无分可跑，才可放过
                // 用户策略："三家只要可能，必须出级牌或王牌，压过二家"，避免四家轻易加分
                const fourthHasScore = this._opponentLikelyHasScore(
                    trickCards, trumpSuit, level, hand, leadPlayer);
                const secondPlayerWeak = this._isSecondPlayerWeak(trickCards, trumpSuit, level, hand);
                if (!fourthHasScore && secondPlayerWeak) {
                    // 四家明确无分可跑，且二家已无强势牌 → 放过，跟最小主牌
                    this._debug(`三家：对手杀主，二家已无强势且四家无分，放过`);
                    return [trumps[0]];
                }
                // 否则尽力压制二家！用强牌反杀
                const killCard = this._grabControlCard(trumps, winnerValue, trumpSuit, level, isLastTrick, hand);
                if (killCard) {
                    this._debug(`三家：对手杀主，尽力压制二家`);
                    return [killCard];
                }
                // 压制不了 → 跟最小主牌
                return [trumps[0]];
            }

            // ================================================================
            // 三家但首家是对手（非对门）→ 通用跟牌
            // ================================================================
            if (position === 3 && !this._isTeammate(leadPlayer)) {
                if (winnerIsTeammate) {
                    // 队友（二家）杀了对手的首牌 → 跑分
                    const runCard = this._getRunScoreCard(trumps);
                    if (runCard) {
                        this._debug(`三家：队友二家杀，跑分`);
                        return [runCard];
                    }
                    return [trumps[0]];
                }
                // 对手在赢 → 尝试赢回来（四家对手还在后面，用强牌抢权）
                const grabCard2 = this._grabControlCard(trumps, winnerValue, trumpSuit, level, isLastTrick, hand);
                if (grabCard2) {
                    this._debug(`三家：对手赢，抢权`);
                    return [grabCard2];
                }
                return [trumps[0]];
            }

            // ================================================================
            // 四家（position=4）：决定胜负，出牌权争夺最关键
            // AI文档："本轮走牌要在自己这里分出胜负，自己的决策就十分重要"
            // ================================================================
            if (position === 4) {
                if (winnerIsTeammate) {
                    // 队友赢 → 跑分
                    const runCard = this._getRunScoreCard(trumps);
                    if (runCard) {
                        this._debug(`四家：队友赢，跑主牌分${runCard.rank}`);
                        return [runCard];
                    }
                    // 无分 → 跟最小主牌
                    return [trumps[0]];
                }
                // 对手赢 → 最后机会，必须想办法赢回来
                for (const trump of trumps) {
                    if (getCardValue(trump, trumpSuit, level) > winnerValue) {
                        // 尾盘非最后一轮保留大王（底牌>5分时才需要保底留大王）
                        if (!isLastTrick && this._isEndGame(hand) &&
                            trump.isJoker && trump.rank === 'big' && !this._shouldSkipBottomProtection()) {
                            continue;
                        }
                        this._debug(`四家：对手赢，抢权`);
                        return [trump];
                    }
                }
                // 赢不了 → 跟最小主牌
                return [trumps[0]];
            }

            // 默认兜底
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
                const winner = getTrickWinner(trickCards, trumpSuit, level, this.memory.playedCards);
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
     *
     * 重要规则：出牌数量必须和首家一致！
     * 如果该花色牌不够（如首家出拖拉机4张，我只有3张该花色），
     * 必须出全部该花色的牌，再用其他花色的牌补足。
     */
    _followSuit(leadSuitCards, leadPattern, iAmWinning, trickScore, trumpSuit, level, trickCards, hand, isDealerTeam, isLastPlayer, leadSuit, position, leadPlayer) {
        const needLen = leadPattern.length;

        // 如果该花色牌数足够，正常跟牌
        if (leadSuitCards.length >= needLen) {
            if (leadPattern.type === 'single') {
                return this._followSingle(leadSuitCards, iAmWinning, trickScore, trumpSuit, level, trickCards, isLastPlayer, leadSuit, hand, position, leadPlayer);
            }
            if (leadPattern.type === 'pair') {
                return this._followPair(leadSuitCards, iAmWinning, trickScore, trumpSuit, level, trickCards, isLastPlayer, leadSuit, hand, position, leadPlayer);
            }
            if (leadPattern.type === 'tractor') {
                return this._followTractor(leadSuitCards, leadPattern.length, iAmWinning, trickScore, trumpSuit, level, trickCards, isLastPlayer, leadSuit);
            }
            return [leadSuitCards[0]];
        }

        // === 该花色牌不够，必须补足垫牌 ===
        // 先出全部该花色的牌
        const result = [...leadSuitCards];

        // 找其他花色的牌来补足
        const otherCards = this._sortByValue(
            hand.filter(c => !isTrump(c, trumpSuit, level) &&
                             c.id !== leadSuitCards[0].id &&
                             !leadSuitCards.some(lc => lc.id === c.id)),
            trumpSuit, level
        );

        // 策略：补牌优先用最小的非分牌，最后才用分牌
        const safeCards = otherCards.filter(c => !this._isPointCard(c));
        const pointCards = otherCards.filter(c => this._isPointCard(c));

        while (result.length < needLen) {
            if (iAmWinning) {
                // 队友赢，垫最小的非分牌
                if (safeCards.length > 0) {
                    result.push(safeCards.shift());
                } else if (pointCards.length > 0) {
                    result.push(pointCards.shift());
                } else {
                    // 没有副牌了，用主牌补
                    const trumps = this._sortByValue(
                        hand.filter(c => isTrump(c, trumpSuit, level) && !result.some(r => r.id === c.id)),
                        trumpSuit, level
                    );
                    if (trumps.length > 0) {
                        result.push(trumps[0]);
                    } else {
                        break; // 实在没有牌了
                    }
                }
            } else {
                // 对手赢，也垫最小的非分牌（反正杀不动）
                if (safeCards.length > 0) {
                    result.push(safeCards.shift());
                } else if (pointCards.length > 0) {
                    result.push(pointCards.shift());
                } else {
                    const trumps = this._sortByValue(
                        hand.filter(c => isTrump(c, trumpSuit, level) && !result.some(r => r.id === c.id)),
                        trumpSuit, level
                    );
                    if (trumps.length > 0) {
                        result.push(trumps[0]);
                    } else {
                        break;
                    }
                }
            }
        }

        return result.slice(0, needLen);
    }

    /**
     * 跟单张副牌
     *
     * 位置感知策略（tractor_AI文档 + 用户补充）：
     *
     * 【三家 position=3，对门（队友）是首家】——本方最后一手，胜负关系大
     *   队友首发大单副牌：
     *     - 二家未毙杀 → 加分数跑分（10>K>5），无分跟小牌
     *     - 二家已毙杀 → 跟随非分小牌
     *   队友首发小单（非绝对大牌）：
     *     - 二家跟非大牌 → 拦截：用A上手，无A用J/Q防四家跑10
     *     - 二家跟大牌（如A）→ 压制：用更大牌压过二家，防四家加10/K
     *       除非四家已明确无分牌 → 放过
     *
     * 【通用策略（position 2/4 或首家非队友）】
     *   - 队友出大牌赢时：贴分牌跑分
     *   - 队友出小牌赢且非最后一家：拦截/跟最小非分牌
     *   - 队友赢且最后一家：贴分牌
     *   - 对手赢：出最大的牌试图赢；赢不了跟最小非分牌
     */
    _followSingle(leadSuitCards, iAmWinning, trickScore, trumpSuit, level, trickCards, isLastPlayer, leadSuit, hand, position, leadPlayer) {
        const winner = getTrickWinner(trickCards, trumpSuit, level, this.memory.playedCards);
        const winnerCard = winner.cards[0];
        const winnerValue = getCardValue(winnerCard, trumpSuit, level);

        // ================================================================
        // 三家（position=3），对门（队友）是首家——专属策略
        // ================================================================
        if (position === 3 && this._isTeammate(leadPlayer) && !isLastPlayer) {
            // 判断队友出的是大单副牌还是小单
            const leadCard = trickCards[0].cards[0];
            const leadValue = getCardValue(leadCard, trumpSuit, level);
            const teammatePlayedBig = leadValue >= 11; // A=11

            // 判断二家是否毙杀（二家是position 2，trickCards[1]）
            const secondPlayerCards = trickCards.length >= 2 ? trickCards[1].cards : [];
            const secondKilled = secondPlayerCards.length > 0 &&
                secondPlayerCards.some(c => isTrump(c, trumpSuit, level));
            const secondCard = secondPlayerCards.length > 0 ? secondPlayerCards[0] : null;
            const secondCardValue = secondCard ? getCardValue(secondCard, trumpSuit, level) : 0;
            const secondPlayedBig = secondCardValue >= 11; // 二家跟了大牌（A）

            // --- 队友首发大单副牌 ---
            if (teammatePlayedBig) {
                if (!secondKilled) {
                    // 二家未毙杀 → 判断四家断门毙杀的可能性再决定是否加分
                    // 强化判断：四家该花色走牌≤3张时，基本不太会断门
                    const fourthPlayedCount = this._countSuitPlayedByPlayer(leadSuit, 4);
                    const fourthLikelyVoid = fourthPlayedCount > 3; // 走牌>3张才有可能断门

                    if (fourthLikelyVoid) {
                        // 四家可能断门毙杀 → 谨慎，跟小牌或小分
                        this._debug(`三家：队友大牌赢，但四家可能断门，谨慎跟小牌`);
                        const nonPoint = leadSuitCards.filter(c => !this._isPointCard(c));
                        if (nonPoint.length > 0) return [nonPoint[0]];
                        // 只有分牌时跟最小分
                        const discardCard = this._getDiscardScoreCard(leadSuitCards);
                        return [discardCard || leadSuitCards[0]];
                    }

                    // 四家不太可能断门 → 加分数跑分（优先10>K>5）
                    const runCard = this._getRunScoreCard(leadSuitCards);
                    if (runCard) {
                        this._debug(`三家：队友大牌赢，四家不太会断门，跑分${runCard.rank}`);
                        return [runCard];
                    }
                    // 无分 → 跟本门小牌
                    const nonPoint = leadSuitCards.filter(c => !this._isPointCard(c));
                    if (nonPoint.length > 0) return [nonPoint[0]];
                    return [leadSuitCards[0]];
                }
                // 二家已毙杀 → 跟随非分小牌
                // 若二家出了绝对大牌（如A），自己压制不住，除非断门——断门时必须毙杀
                const nonPoint = leadSuitCards.filter(c => !this._isPointCard(c));
                if (nonPoint.length > 0) return [nonPoint[0]];
                // 全是分牌 → 垫最小分牌
                const discardCard = this._getDiscardScoreCard(leadSuitCards);
                return [discardCard || leadSuitCards[0]];
            }

            // --- 队友首发小单（非绝对大牌）---
            // 用户策略："队友首发出小单（包括所有非绝对大牌），比如副牌黑桃4"
            if (!secondKilled && secondCard) {
                // 二家跟了牌（未毙杀）
                if (!secondPlayedBig) {
                    // 二家跟的不是绝对大牌（如黑桃8）→ 拦截！
                    // 用户策略："要么用绝对大牌上手比如黑桃A，若没有黑桃A，
                    //   至少要用黑桃JQ之类，防止第四家用黑桃10轻易得分"
                    //   "第四家的黑桃K，本来就防不住，也就不必考虑防御"
                    const interceptCard = this._findSingleInterceptCard(
                        leadSuitCards, winnerValue, trumpSuit, level);
                    if (interceptCard) {
                        this._debug(`三家：队友小牌，二家非大牌，拦截防四家跑10`);
                        return [interceptCard];
                    }
                    // 没有合适的拦截牌 → 跟最小非分牌
                    const nonPoint = leadSuitCards.filter(c => !this._isPointCard(c));
                    if (nonPoint.length > 0) return [nonPoint[0]];
                    const discardCard = this._getDiscardScoreCard(leadSuitCards);
                    return [discardCard || leadSuitCards[0]];
                }

                // 二家跟了大牌（如A）→ 压制！
                // 用户策略："队友首发主牌红桃4，二家跟红桃A，作为三家，只要可能，
                //   必须出级牌或王牌，压过二家，避免四家直接加10或K得分"
                //   "除非牌面已经判断出，四家手中无分数牌，那可以放过"
                const fourthHasScore = this._opponentLikelyHasScore(
                    trickCards, trumpSuit, level, hand, leadPlayer);
                if (fourthHasScore) {
                    // 四家可能有分牌 → 必须压制二家
                    for (let i = leadSuitCards.length - 1; i >= 0; i--) {
                        if (getCardValue(leadSuitCards[i], trumpSuit, level) > secondCardValue) {
                            this._debug(`三家：二家跟大牌，压制二家防四家跑分`);
                            return [leadSuitCards[i]];
                        }
                    }
                    // 压不过 → 跟最小非分牌
                    const nonPoint = leadSuitCards.filter(c => !this._isPointCard(c));
                    if (nonPoint.length > 0) return [nonPoint[0]];
                    const discardCard = this._getDiscardScoreCard(leadSuitCards);
                    return [discardCard || leadSuitCards[0]];
                }
                // 四家大概率无分牌 → 放过，跟最小非分牌
                this._debug(`三家：二家跟大牌但四家无分牌，放过`);
                const nonPoint = leadSuitCards.filter(c => !this._isPointCard(c));
                if (nonPoint.length > 0) return [nonPoint[0]];
                const discardCard = this._getDiscardScoreCard(leadSuitCards);
                return [discardCard || leadSuitCards[0]];
            }

            // 二家毙杀了（对手在赢）→ 跟随非分小牌
            // AI文档："若二家已经毙杀，自己未断门，跟随非分小牌"
            const nonPoint = leadSuitCards.filter(c => !this._isPointCard(c));
            if (nonPoint.length > 0) return [nonPoint[0]];
            const discardCard = this._getDiscardScoreCard(leadSuitCards);
            return [discardCard || leadSuitCards[0]];
        }

        // ================================================================
        // 通用策略（position 2/4 或首家非队友）
        // ================================================================
        if (iAmWinning) {
            const teammatePlayedBig = winnerValue >= 11; // A=11

            if (isLastPlayer) {
                const runCard = this._getRunScoreCard(leadSuitCards);
                if (runCard) return [runCard];
                return [leadSuitCards[0]];
            }

            if (teammatePlayedBig) {
                const runCard = this._getRunScoreCard(leadSuitCards);
                if (runCard) return [runCard];
                return [leadSuitCards[0]];
            }

            // 队友出小牌赢，非最后一家 → 拦截
            if (this._shouldIntercept(hand, trickCards, trickScore, trumpSuit, level, leadSuit)) {
                const interceptCard = this._findInterceptCard(leadSuitCards, trumpSuit, level);
                if (interceptCard) return [interceptCard];
            }

            const nonPoint = leadSuitCards.filter(c => !this._isPointCard(c));
            if (nonPoint.length > 0) return [this._pickRandom(nonPoint.slice(0, Math.min(2, nonPoint.length)))];
            const discardCard = this._getDiscardScoreCard(leadSuitCards);
            return [discardCard || leadSuitCards[0]];
        }

        // 对手赢
        const winnerIsTrump = isTrump(winnerCard, trumpSuit, level);
        if (!winnerIsTrump) {
            const winnerValue2 = getCardValue(winnerCard, trumpSuit, level);
            for (let i = leadSuitCards.length - 1; i >= 0; i--) {
                if (getCardValue(leadSuitCards[i], trumpSuit, level) > winnerValue2) {
                    return [leadSuitCards[i]];
                }
            }
        }
        if (this._teammateLikelyToKill(leadSuit, trickCards, trumpSuit, level)) {
            const runCard = this._getRunScoreCard(leadSuitCards);
            if (runCard) return [runCard];
        }
        const nonPoint = leadSuitCards.filter(c => !this._isPointCard(c));
        if (nonPoint.length > 0) return [nonPoint[0]];
        const discardCard = this._getDiscardScoreCard(leadSuitCards);
        return [discardCard || leadSuitCards[0]];
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
    _followPair(leadSuitCards, iAmWinning, trickScore, trumpSuit, level, trickCards, isLastPlayer, leadSuit, hand, position, leadPlayer) {
        const pairs = this._findPairs(leadSuitCards, trumpSuit, level);

        // ================================================================
        // 三家（position=3），对门（队友）是首家——专属策略
        // ================================================================
        if (position === 3 && this._isTeammate(leadPlayer) && !isLastPlayer && pairs.length > 0) {
            const pointPairs = pairs.filter(p => p.some(c => this._isPointCard(c)));
            const nonPointPairs = pairs.filter(p => !p.some(c => this._isPointCard(c)));

            const leadCard = trickCards[0].cards[0];
            const leadValue = getCardValue(leadCard, trumpSuit, level);
            const teammatePlayedBig = leadValue >= 11; // A对

            // 判断二家是否毙杀
            const secondPlayerCards = trickCards.length >= 2 ? trickCards[1].cards : [];
            const secondKilled = secondPlayerCards.length > 0 &&
                secondPlayerCards.some(c => isTrump(c, trumpSuit, level));
            const secondCardValue = secondPlayerCards.length > 0
                ? getCardValue(secondPlayerCards[0], trumpSuit, level) : 0;

            // --- 队友首发大对子 ---
            if (teammatePlayedBig) {
                if (!secondKilled) {
                    // 二家未毙杀 → 队友大对在赢
                    // 综合走牌历史判断队友这对子最终能否赢（含四家断门杀主的风险），再决定是否跑分
                    // 队友走绝对大牌时，三家也要考虑四家断门反杀的可能，而非机械跑分
                    const bigLikelyWin = this._teammatePairLikelyWin(
                        trickCards, trumpSuit, level, hand, leadSuit, leadPlayer, isLastPlayer);
                    if (bigLikelyWin) {
                        if (pointPairs.length > 0) {
                            const runPriority = { '10': 3, 'K': 2, '5': 1 };
                            const sorted = [...pointPairs].sort((a, b) =>
                                (runPriority[b[0].rank] || 0) - (runPriority[a[0].rank] || 0));
                            this._debug(`三家：队友大对大概率赢，跑分对${sorted[0][0].rank}`);
                            return sorted[0];
                        }
                        // 无分牌对子 → 出最大非分牌对子（帮队友消耗）
                        if (nonPointPairs.length > 0) return nonPointPairs[nonPointPairs.length - 1];
                        return pairs[pairs.length - 1];
                    }
                    // 队友未必能赢（如四家断门可能杀主反超）→ 保守跟最小非分牌对子
                    this._debug(`三家：队友大对但有被反超风险，保守跟小对`);
                    if (nonPointPairs.length > 0) return nonPointPairs[0];
                    return pairs[0];
                }
                // 二家已毙杀 → 跟最小非分牌对子
                if (nonPointPairs.length > 0) return nonPointPairs[0];
                return pairs[0];
            }

            // --- 队友首发小对子 ---
            if (!secondKilled) {
                // 二家跟了对子（未毙杀）
                // 拦截：用能赢的最小对子压制，防四家跑分对
                const winner = getTrickWinner(trickCards, trumpSuit, level, this.memory.playedCards);
                const winnerValue = getCardValue(winner.cards[0], trumpSuit, level);
                for (const pair of nonPointPairs) {
                    if (getCardValue(pair[0], trumpSuit, level) > winnerValue) {
                        this._debug(`三家：队友小对，拦截防四家跑分`);
                        return pair;
                    }
                }
                // 非分牌对子赢不了 → 看分牌对子能否赢（关键时刻也用）
                const fourthHasScore = this._opponentLikelyHasScore(
                    trickCards, trumpSuit, level, hand, leadPlayer);
                if (fourthHasScore) {
                    for (const pair of pointPairs) {
                        if (getCardValue(pair[0], trumpSuit, level) > winnerValue) {
                            this._debug(`三家：队友小对，用分牌对拦截`);
                            return pair;
                        }
                    }
                }
                // 赢不了 → 跟最小非分牌对子
                if (nonPointPairs.length > 0) return nonPointPairs[0];
                return pairs[0];
            }

            // 二家毙杀了 → 跟最小非分牌对子
            if (nonPointPairs.length > 0) return nonPointPairs[0];
            return pairs[0];
        }

        // ================================================================
        // 通用策略（position 2/4 或首家非队友）
        // ================================================================

        if (pairs.length > 0) {
            // 分离分牌对子和非分牌对子
            const pointPairs = pairs.filter(p => p.some(c => this._isPointCard(c)));
            const nonPointPairs = pairs.filter(p => !p.some(c => this._isPointCard(c)));

            if (iAmWinning) {
                // === 队友在赢 ===
                if (isLastPlayer) {
                    // 最后一家，队友赢，贴分牌对子跑分
                    // AI文档："优先跑10（分值高），其次跑K，最次跑5"
                    if (pointPairs.length > 0) {
                        const runPriority = { '10': 3, 'K': 2, '5': 1 };
                        const sorted = [...pointPairs].sort((a, b) =>
                            (runPriority[b[0].rank] || 0) - (runPriority[a[0].rank] || 0));
                        return sorted[0];
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

                // 不需要出牌权 → 根据走牌历史判断队友这对子最终能否赢下来，决定是否出分牌对子配合跑分
                const pairLikelyWin = this._teammatePairLikelyWin(
                    trickCards, trumpSuit, level, hand, leadSuit, leadPlayer, isLastPlayer);
                if (pairLikelyWin && pointPairs.length > 0) {
                    // 队友大概率能赢 → 出分牌对子配合跑分（优先10>K>5），而非机械保留分牌对子
                    const runPriority = { '10': 3, 'K': 2, '5': 1 };
                    const sorted = [...pointPairs].sort((a, b) =>
                        (runPriority[b[0].rank] || 0) - (runPriority[a[0].rank] || 0));
                    this._debug(`跟对子：队友大概率赢，配合跑分对${sorted[0][0].rank}`);
                    return sorted[0];
                }
                // 队友未必能赢或无分牌对子 → 出最小非分牌对子（保留分牌对子）
                if (nonPointPairs.length > 0) return nonPointPairs[0];
                // 只有分牌对子，出最小的
                return pairs[0];
            }

            // === 对手在赢 ===
            // 先看能不能杀（同花色内比大小）
            const winner = getTrickWinner(trickCards, trumpSuit, level, this.memory.playedCards);
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

        // 没有对子，出两张散牌跟对子（合法但赢不了）
        if (iAmWinning) {
            if (isLastPlayer) {
                // 最后一家，队友赢，贴分牌跑分
                // AI文档："优先跑10（分值高），其次跑K，最次跑5"
                const result = [];
                const remaining = [...leadSuitCards];
                // 依次取最优跑分牌（10>K>5）
                for (let i = 0; i < 2 && remaining.length > 0; i++) {
                    const runCard = this._getRunScoreCard(remaining);
                    if (runCard) {
                        result.push(runCard);
                        remaining.splice(remaining.indexOf(runCard), 1);
                    } else {
                        // 没分牌了，出最小的非分牌
                        const nonPoint = remaining.filter(c => !this._isPointCard(c));
                        if (nonPoint.length > 0) {
                            result.push(nonPoint[0]);
                            remaining.splice(remaining.indexOf(nonPoint[0]), 1);
                        } else {
                            result.push(remaining[0]);
                            remaining.shift();
                        }
                    }
                }
                return result;
            }
            // 非最后一家，队友赢，出最小的两张非分牌
            const nonPoint = leadSuitCards.filter(c => !this._isPointCard(c));
            if (nonPoint.length >= 2) return [nonPoint[0], nonPoint[1]];
            // 只有1张非分牌，出非分牌+被迫垫分牌（优先5>10>K，先出分值低的）
            if (nonPoint.length === 1) {
                const remaining = leadSuitCards.filter(c => c.id !== nonPoint[0].id);
                const discardCard = this._getDiscardScoreCard(remaining);
                return [nonPoint[0], discardCard || remaining[0]];
            }
            // 全是分牌，被迫垫分牌（优先5>10>K，先出分值低的）
            const allPointResult = [];
            const remaining = [...leadSuitCards];
            for (let i = 0; i < 2 && remaining.length > 0; i++) {
                const discardCard = this._getDiscardScoreCard(remaining);
                if (discardCard) {
                    allPointResult.push(discardCard);
                    remaining.splice(remaining.indexOf(discardCard), 1);
                } else {
                    allPointResult.push(remaining[0]);
                    remaining.shift();
                }
            }
            return allPointResult;
        }

        // 对手赢，散牌跟对子赢不了，尽量少送分
        // 先看能不能赢（同花色内比大小）
        const winner = getTrickWinner(trickCards, trumpSuit, level, this.memory.playedCards);
        const winnerCard = winner.cards[0];
        const winnerIsTrump = isTrump(winnerCard, trumpSuit, level);

        if (!winnerIsTrump) {
            // 当前赢家是副牌对子，散牌不可能赢对子
            // 被迫垫牌：优先非分牌，再垫分牌（5>10>K，先出分值低的）
            const nonPoint = leadSuitCards.filter(c => !this._isPointCard(c));
            if (nonPoint.length >= 2) return [nonPoint[0], nonPoint[1]];
            if (nonPoint.length === 1) {
                const remaining = leadSuitCards.filter(c => c.id !== nonPoint[0].id);
                const discardCard = this._getDiscardScoreCard(remaining);
                return [nonPoint[0], discardCard || remaining[0]];
            }
        }

        // 对手杀主了或全是分牌 → 被迫垫分牌（优先5>10>K）
        const discardResult = [];
        const remaining = [...leadSuitCards];
        for (let i = 0; i < 2 && remaining.length > 0; i++) {
            const discardCard = this._getDiscardScoreCard(remaining);
            if (discardCard) {
                discardResult.push(discardCard);
                remaining.splice(remaining.indexOf(discardCard), 1);
            } else {
                discardResult.push(remaining[0]);
                remaining.shift();
            }
        }
        return discardResult.length > 0 ? discardResult : [leadSuitCards[0]];
    }

    /**
     * 跟拖拉机副牌
     * 跟牌优先级：拖拉机 → 2对子 → 1对子+单牌 → 4单牌
     * 队友赢时贴分跑分；对手拖拉机赢时出小牌跟随，保留实力和分数（拖拉机99%赢不了，避其锋芒）
     */
    _followTractor(leadSuitCards, needLen, iAmWinning, trickScore, trumpSuit, level, trickCards, isLastPlayer, leadSuit) {
        const tractors = this._findTractors(leadSuitCards, trumpSuit, level);
        const pairs = this._findPairs(leadSuitCards, trumpSuit, level);
        const neededPairs = needLen / 2;

        // 1. 有拖拉机
        const matching = tractors.find(t => t.length >= needLen);
        if (matching) {
            if (iAmWinning) {
                // 队友赢，拖拉机很强罕见被杀，贴分跑分
                // 如果拖拉机含分牌，优先出含分牌的拖拉机
                const pointTractors = tractors.filter(t =>
                    t.length >= needLen && t.some(c => this._isPointCard(c))
                );
                if (pointTractors.length > 0) {
                    return pointTractors[0].slice(0, needLen);
                }
                return matching.slice(0, needLen);
            }
            // 对手拖拉机赢。拖拉机只有"真的能赢"和"完全不能赢"两种，99%不能赢。
            // 能赢：出最小能赢的拖拉机；不能赢：出最小拖拉机跟随，避其锋芒、保留实力与分数。
            const tractorWinner = getTrickWinner(trickCards, trumpSuit, level, this.memory.playedCards);
            const tractorWinVal = getCardValue(tractorWinner.cards[0], trumpSuit, level);
            const winTractor = tractors
                .filter(t => t.length >= needLen &&
                    getCardValue(t[0], trumpSuit, level) > tractorWinVal)
                .sort((a, b) => getCardValue(a[0], trumpSuit, level) - getCardValue(b[0], trumpSuit, level))[0];
            if (winTractor) {
                this._debug(`跟拖拉机：有更大拖拉机，出最小能赢拖拉机`);
                return winTractor.slice(0, needLen);
            }
            this._debug(`跟拖拉机：对手拖拉机赢，赢不了，出最小拖拉机跟随`);
            return matching.slice(0, needLen);
        }

        // 2. 没有拖拉机，有2+对子
        if (pairs.length >= 2) {
            const result = [];
            if (iAmWinning) {
                // 队友赢，贴分跑分
                const pointPairs = pairs.filter(p => p.some(c => this._isPointCard(c)));
                const nonPointPairs = pairs.filter(p => !p.some(c => this._isPointCard(c)));
                if (isLastPlayer) {
                    // 最后一家，优先出分牌对子
                    for (const pair of pointPairs) {
                        result.push(...pair);
                        if (result.length >= needLen) break;
                    }
                }
                // 非最后一家或分牌对子不够，出非分牌对子
                for (const pair of nonPointPairs) {
                    if (result.length >= needLen) break;
                    result.push(...pair);
                }
                // 还不够，用分牌对子补
                if (!isLastPlayer) {
                    for (const pair of pointPairs) {
                        if (result.length >= needLen) break;
                        result.push(...pair);
                    }
                }
            } else {
                // 对手拖拉机赢，99%赢不了，出最小对子跟随，保留实力和分数
                // 优先出非分牌对子（保留分牌），从最小的开始
                const opNonPointPairs = pairs.filter(p => !p.some(c => this._isPointCard(c)));
                const opPointPairs = pairs.filter(p => p.some(c => this._isPointCard(c)));
                const opSource = opNonPointPairs.length >= neededPairs
                    ? opNonPointPairs : [...opNonPointPairs, ...opPointPairs];
                for (let i = 0; i < Math.min(neededPairs, opSource.length); i++) {
                    result.push(...opSource[i]);
                }
            }
            // 不够用单牌补
            const used = new Set(result.map(c => c.id));
            const unused = leadSuitCards.filter(c => !used.has(c.id));
            while (result.length < needLen && unused.length > 0) {
                if (iAmWinning && isLastPlayer) {
                    const point = unused.find(c => this._isPointCard(c));
                    if (point) {
                        result.push(point);
                        unused.splice(unused.indexOf(point), 1);
                    } else {
                        result.push(unused.shift());
                    }
                } else if (iAmWinning) {
                    result.push(unused.shift());
                } else {
                    // 对手拖拉机赢，99%赢不了，出最小非分牌跟随，保留分牌
                    const opNonPoint = unused.find(c => !this._isPointCard(c));
                    if (opNonPoint) {
                        result.push(opNonPoint);
                        unused.splice(unused.indexOf(opNonPoint), 1);
                    } else {
                        result.push(unused.shift());
                    }
                }
            }
            return result.slice(0, needLen);
        }

        // 3. 只有1个对子
        if (pairs.length === 1) {
            const result = [...pairs[0]];
            const used = new Set(result.map(c => c.id));
            const unused = leadSuitCards.filter(c => !used.has(c.id));
            while (result.length < needLen && unused.length > 0) {
                if (iAmWinning && isLastPlayer) {
                    // 最后一家贴分牌
                    const point = unused.find(c => this._isPointCard(c));
                    if (point) {
                        result.push(point);
                        unused.splice(unused.indexOf(point), 1);
                    } else {
                        result.push(unused.shift());
                    }
                } else if (iAmWinning) {
                    result.push(unused.shift());
                } else {
                    // 对手拖拉机赢，99%赢不了，出最小非分牌跟随，保留分牌
                    const opNonPoint = unused.find(c => !this._isPointCard(c));
                    if (opNonPoint) {
                        result.push(opNonPoint);
                        unused.splice(unused.indexOf(opNonPoint), 1);
                    } else {
                        result.push(unused.shift());
                    }
                }
            }
            return result.slice(0, needLen);
        }

        // 4. 没有对子，全出单牌
        if (iAmWinning && isLastPlayer) {
            // 最后一家队友赢，优先贴分牌
            const pointCards = leadSuitCards.filter(c => this._isPointCard(c));
            const nonPointCards = leadSuitCards.filter(c => !this._isPointCard(c));
            const result = [];
            while (result.length < needLen && pointCards.length > 0) {
                result.push(pointCards.pop());
            }
            while (result.length < needLen && nonPointCards.length > 0) {
                result.push(nonPointCards.shift());
            }
            return result.slice(0, needLen);
        }
        if (iAmWinning) {
            // 非最后一家队友赢，出最小的非分牌
            const nonPoint = leadSuitCards.filter(c => !this._isPointCard(c));
            if (nonPoint.length >= needLen) return nonPoint.slice(0, needLen);
            const result = [...nonPoint];
            const pointCards = leadSuitCards.filter(c => this._isPointCard(c));
            while (result.length < needLen && pointCards.length > 0) {
                result.push(pointCards.shift());
            }
            return result.slice(0, needLen);
        }
        // 对手拖拉机赢，99%赢不了，出最小非分牌跟随，保留实力和分数
        const opNonPointAll = leadSuitCards.filter(c => !this._isPointCard(c));
        const opPointAll = leadSuitCards.filter(c => this._isPointCard(c));
        if (opNonPointAll.length >= needLen) return opNonPointAll.slice(0, needLen);
        const opResult = [...opNonPointAll];
        while (opResult.length < needLen && opPointAll.length > 0) {
            opResult.push(opPointAll.shift());
        }
        return opResult.slice(0, needLen);
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
    _followNoSuit(trumps, hand, leadPattern, trickCards, iAmWinning, trickScore, trumpSuit, level, isDealerTeam, isLastPlayer, leadSuit, position, leadPlayer) {
        const nonTrumps = this._sortByValue(
            hand.filter(c => !isTrump(c, trumpSuit, level)), trumpSuit, level
        );
        const needLen = leadPattern.length;

        // ================================================================
        // 三家（position=3），对门（队友）是首家——断门专属策略
        // AI文档："断门，可垫其他副牌10分或5分；也可毙杀主牌分，接过出牌权"
        //         "若二家毙杀，自己也断门，用更大主牌毙杀，压过二家"
        // ================================================================
        if (position === 3 && this._isTeammate(leadPlayer) && !isLastPlayer) {
            const winner = getTrickWinner(trickCards, trumpSuit, level, this.memory.playedCards);
            const winnerValue = getCardValue(winner.cards[0], trumpSuit, level);
            const winnerIsTeammate = this._isTeammate(winner.player);

            // 判断二家是否毙杀
            const secondPlayerCards = trickCards.length >= 2 ? trickCards[1].cards : [];
            const secondKilled = secondPlayerCards.length > 0 &&
                secondPlayerCards.some(c => isTrump(c, trumpSuit, level));

            if (winnerIsTeammate && !secondKilled) {
                // 队友在赢，二家没杀 → 断门跑分
                // "可垫其他副牌10分或5分"
                const pointCards = nonTrumps.filter(c => this._isPointCard(c));
                const result = [];
                const used = new Set();
                // 先垫最大的分牌
                for (let i = pointCards.length - 1; i >= 0 && result.length < needLen; i--) {
                    result.push(pointCards[i]);
                    used.add(pointCards[i].id);
                }
                // 不够垫最小非分牌
                const safeCards = nonTrumps.filter(c => !this._isPointCard(c) && !used.has(c.id));
                for (const card of safeCards) {
                    if (result.length >= needLen) break;
                    result.push(card);
                    used.add(card.id);
                }
                // 还不够垫最小主牌
                for (const card of trumps) {
                    if (result.length >= needLen) break;
                    if (!used.has(card.id)) {
                        result.push(card);
                        used.add(card.id);
                    }
                }
                this._debug(`三家：断门，队友赢，跑分`);
                return result.slice(0, needLen);
            }

            // 二家杀了或对手在赢 → 尝试用更大主牌毙杀
            // "也可毙杀主牌分，接过出牌权"
            // "若二家毙杀，自己也断门，用更大主牌毙杀，压过二家"
            if (trumps.length >= needLen) {
                const killCards = this._killWithTrump(trumps, leadPattern, trickCards, trumpSuit, level, needLen);
                if (killCards) {
                    // 验证杀的牌比当前赢家大
                    const killValue = getCardValue(killCards[0], trumpSuit, level);
                    if (killValue > winnerValue || leadPattern.type !== 'single') {
                        this._debug(`三家：断门，毙杀压过二家`);
                        return killCards;
                    }
                }
            }

            // 杀不了 → 垫牌（优先跑分）
            const pointCards = nonTrumps.filter(c => this._isPointCard(c));
            const result = [];
            const used = new Set();
            for (let i = pointCards.length - 1; i >= 0 && result.length < needLen; i--) {
                result.push(pointCards[i]);
                used.add(pointCards[i].id);
            }
            const safeCards = nonTrumps.filter(c => !this._isPointCard(c) && !used.has(c.id));
            for (const card of safeCards) {
                if (result.length >= needLen) break;
                result.push(card);
                used.add(card.id);
            }
            for (const card of trumps) {
                if (result.length >= needLen) break;
                if (!used.has(card.id)) {
                    result.push(card);
                    used.add(card.id);
                }
            }
            return result.slice(0, needLen);
        }

        // === 预判队友杀牌 → 主动加分 ===
        // "预判队友可能有较高机会杀牌而主动加分"
        // 条件：队友还没出牌 + 队友很可能断了该花色（记忆有记录）
        // 此时队友大概率会用主牌杀，我垫的分会被队友一并收走
        //
        // 【限制】不能盲目垫分：除非是第二家（首家是对手出的副牌，第四家队友明确断门可以毙杀），
        // 才可以垫分等第四家杀。其余位置（三家/四家）即便预判队友可能杀，也不主动垫分，
        // 避免垫出的分牌被对手收走。
        const teammateMightKill = this._teammateLikelyToKill(leadSuit, trickCards, trumpSuit, level);
        // 仅当处于第二家、且首家是对手时，第四家才是队友，才可放心垫分等其毙杀
        const safeToWaitForFourthKill =
            (position === 2) && leadPlayer && !this._isTeammate(leadPlayer);
        if (teammateMightKill && safeToWaitForFourthKill) {
            // 队友会杀：垫分牌等第四家杀！断门后找出所有大分牌
            // 但保留主牌的分数对子或拖拉机（太值钱，留给队友大牌时贴）
            const pointCards = nonTrumps.filter(c => this._isPointCard(c));
            const result = [];
            const used = new Set();
            // 先垫最大的副牌分牌（队友杀牌会一起收走）
            for (let i = pointCards.length - 1; i >= 0 && result.length < needLen; i--) {
                result.push(pointCards[i]);
                used.add(pointCards[i].id);
            }
            // 不够再垫最小的非分副牌
            const safeCards = nonTrumps.filter(c => !this._isPointCard(c) && !used.has(c.id));
            for (const card of safeCards) {
                if (result.length >= needLen) break;
                result.push(card);
                used.add(card.id);
            }
            // 最后垫最小主牌（非分牌对子/拖拉机保留）
            if (result.length < needLen) {
                for (const card of trumps) {
                    if (result.length >= needLen) break;
                    if (!used.has(card.id)) {
                        result.push(card);
                        used.add(card.id);
                    }
                }
            }
            return result.slice(0, needLen);
        }

        // === 队友在赢 → 垫牌 ===
        if (iAmWinning) {
            if (isLastPlayer) {
                // 最后一家，队友赢，贴分牌（优先出分牌跑分）
                const pointCards = nonTrumps.filter(c => this._isPointCard(c));
                const safeCards = nonTrumps.filter(c => !this._isPointCard(c));
                const result = [];
                const used = new Set();

                // 先贴最大的分牌
                for (let i = pointCards.length - 1; i >= 0 && result.length < needLen; i--) {
                    result.push(pointCards[i]);
                    used.add(pointCards[i].id);
                }
                // 再垫最小的非分牌
                for (const card of safeCards) {
                    if (result.length >= needLen) break;
                    if (!used.has(card.id)) {
                        result.push(card);
                        used.add(card.id);
                    }
                }
                // 最后垫最小的主牌
                for (const card of trumps) {
                    if (result.length >= needLen) break;
                    if (!used.has(card.id)) {
                        result.push(card);
                        used.add(card.id);
                    }
                }
                return result.slice(0, needLen);
            }
            // 非最后一家，队友赢，垫最小的非分牌
            return this._discardCards(nonTrumps, trumps, needLen);
        }

        // === 对手在赢 ===

        // 有分在桌上 → 必须杀（除非没主牌或无法同型杀）
        if (trickScore > 0) {
            if (trumps.length >= needLen) {
                const killCards = this._killWithTrump(trumps, leadPattern, trickCards, trumpSuit, level, needLen);
                if (killCards) return killCards;
                // 无法同型杀（如杀对子但没有主牌对子），只能垫牌
            }
            // 没主牌或无法杀，只能垫牌（优先非分牌）
            return this._discardCards(nonTrumps, trumps, needLen);
        }

        // 无分在桌上 → 根据是否需要出牌权决定杀主或垫牌
        // 断门的核心价值：杀牌既拿分又抢出牌权。只要AI有强势牌要主动走
        // （副牌A/大对子/拖拉机，或主牌强势想消耗对手主牌），就应该杀主抢权；
        // 只有牌面无分且AI无强势牌可走时，才放弃杀牌垫副牌。
        if (trumps.length >= needLen && nonTrumps.length >= needLen) {
            // 先检查能否同型杀
            const canKill = (leadPattern.type === 'single') ||
                (leadPattern.type === 'pair' && this._findPairs(trumps, trumpSuit, level).length > 0) ||
                (leadPattern.type === 'tractor' && this._findTractors(trumps, trumpSuit, level).length > 0);

            if (canKill) {
                // 是否需要出牌权：有强势副牌要走，或主牌强势(对子/拖拉机)想上手主动出主消耗对手
                const wantControl = this._wantControl(hand, trumpSuit, level, leadSuit);
                const strongTrumpToLead = this._hasStrongTrumpToLead(trumps, hand, trumpSuit, level);
                if (wantControl || strongTrumpToLead) {
                    const killCards = this._killWithTrump(trumps, leadPattern, trickCards, trumpSuit, level, needLen);
                    if (killCards) return killCards;
                }
            }
            // 无需出牌权或无法同型杀 → 垫副牌
            return this._discardCards(nonTrumps, trumps, needLen);
        }

        // 只有一种选择
        if (trumps.length >= needLen) {
            // 有主牌但没副牌 → 尝试杀主
            const killCards = this._killWithTrump(trumps, leadPattern, trickCards, trumpSuit, level, needLen);
            if (killCards) return killCards;
            // 无法同型杀，只能垫副牌（如果有）
        }

        // 没主牌或无法杀 → 只能垫副牌
        return this._discardCards(nonTrumps, trumps, needLen);
    }

    // ================================================================
    //  甩牌跟牌策略
    // ================================================================

    /**
     * 跟甩牌
     *
     * 甩牌跟牌规则：
     *   - 必须跟数量相同的牌
     *   - 有同花色的必须跟（有多少跟多少），不够的可以垫任何牌
     *   - 要杀的话，必须断门，出数量一样多的全主牌，
     *     且拖拉机数≥甩牌拖拉机数、对子数≥甩牌对子数
     *
     * AI策略（tractor_AI文档）：
     *   1. 有花色时：
     *      - 队友甩牌（对方大概率杀不动）→ 疯狂垫分牌跑分！选最大的分牌
     *        AI文档："队友首发甩牌，二家没杀的话，垫副牌分数，能断门的花色优先垫"
     *      - 对手甩牌 → 本门未断门但都是小牌就跟小牌，数量不够就尽量找能断门的
     *        其他副牌来垫；已断门的更是找能断门的其他副牌来垫
     *   2. 断门时：
     *      - 能杀且对手在赢 → 判断要不要不惜代价杀
     *        AI文档："甩牌通常是多张，断门的情况下可以加很多分来跑"
     *        "如果三家加了很多分（比如20+），能毙杀自然要毙杀；分不多的话，
     *         不毙杀也可以养精蓄锐徐徐图之，正好垫牌断门其他副牌"
     *      - 不能杀或队友在赢 → 按上述垫牌策略
     */
    _followThrow(hand, leadPattern, leadSuit, trickCards, iAmWinning, trickScore, trumpSuit, level, isLastPlayer, trumps) {
        const needLen = leadPattern.length;
        // 使用analyzeCardStructure获取甩牌的拖拉机数和对子数（修正后毙杀条件需匹配）
        const leadStruct = analyzeCardStructure(trickCards[0].cards, trumpSuit, level);
        const leadTractorCount = leadStruct.tractors.length;
        const leadPairCount = leadStruct.pairs.length;

        // 该花色的副牌
        const leadSuitCards = leadSuit ? this._sortByValue(
            hand.filter(c => !c.isJoker && c.suit === leadSuit && !isTrump(c, trumpSuit, level)),
            trumpSuit, level
        ) : [];

        const hasLeadSuit = leadSuitCards.length > 0;

        // === 有该花色：必须跟，不够的垫其他牌 ===
        if (hasLeadSuit) {
            return this._followThrowHasSuit(leadSuitCards, needLen, iAmWinning, hand, trumps, trumpSuit, level);
        }

        // === 断门：可以杀或垫牌 ===
        // 修正：检查拖拉机数和对子数是否足够杀甩牌
        const canKill = trumps.length >= needLen;
        const trumpStruct = canKill ? analyzeCardStructure(trumps, trumpSuit, level) : { tractors: [], pairs: [] };
        const hasEnoughStructure = trumpStruct.tractors.length >= leadTractorCount &&
                                    trumpStruct.pairs.length >= leadPairCount;

        if (canKill && hasEnoughStructure && !iAmWinning) {
            // 对手在赢，尝试杀
            // AI文档："万幸能毙杀的话，结合场上局势，判断要不要不惜代价毙杀"
            //   - 三家加了很多分（20+）→ 必须杀
            //   - 分不多（5-15）→ 可以不杀，养精蓄锐，垫牌断门
            const shouldKill = trickScore >= 15 || isLastPlayer;
            if (shouldKill) {
                const killResult = this._killThrow(trumps, leadTractorCount, leadPairCount, needLen, trumpSuit, level, trickCards);
                if (killResult) return killResult;
            }
            // 杀不了或分不多不值得杀 → 垫牌
        }

        // 垫牌
        const nonTrumps = this._sortByValue(
            hand.filter(c => !isTrump(c, trumpSuit, level)), trumpSuit, level
        );
        return this._discardThrow(nonTrumps, trumps, needLen, iAmWinning);
    }

    /**
     * 有花色时跟甩牌
     * 必须出全部该花色的牌（如果不够），剩余用其他牌补足
     * 如果该花色牌足够，选择最优的出牌组合
     */
    _followThrowHasSuit(leadSuitCards, needLen, iAmWinning, hand, trumps, trumpSuit, level) {
        const used = new Set();

        if (leadSuitCards.length <= needLen) {
            // 该花色牌不够或刚好够 → 全部出，补足其他牌
            const result = [...leadSuitCards];
            leadSuitCards.forEach(c => used.add(c.id));

            const needPad = needLen - result.length;
            if (needPad > 0) {
                // 找其他牌补足（非主牌优先，主牌最后）
                const otherNonTrumps = this._sortByValue(
                    hand.filter(c => !isTrump(c, trumpSuit, level) && !used.has(c.id)),
                    trumpSuit, level
                );
                this._padThrowCards(result, used, needLen, otherNonTrumps, trumps, iAmWinning);
            }
            return result.slice(0, needLen);
        }

        // 该花色牌比需要的多 → 选择出哪些
        if (iAmWinning) {
            // 队友甩牌 → 贴最大的分数牌跑分
            const pointCards = leadSuitCards.filter(c => this._isPointCard(c));
            const nonPointCards = leadSuitCards.filter(c => !this._isPointCard(c));
            const selected = [];

            // 先选最大的分牌
            for (let i = pointCards.length - 1; i >= 0 && selected.length < needLen; i--) {
                selected.push(pointCards[i]);
            }
            // 再选非分牌（从小到大，保留大的非分牌）
            for (const card of nonPointCards) {
                if (selected.length >= needLen) break;
                selected.push(card);
            }
            return selected.slice(0, needLen);
        }

        // 对手甩牌 → 跟最小的非分牌（保留分牌）
        const nonPoint = leadSuitCards.filter(c => !this._isPointCard(c));
        if (nonPoint.length >= needLen) {
            return nonPoint.slice(0, needLen);
        }
        // 非分牌不够，补最小的分牌
        const result = [...nonPoint];
        const pointCards = leadSuitCards.filter(c => this._isPointCard(c));
        for (const card of pointCards) {
            if (result.length >= needLen) break;
            result.push(card);
        }
        return result.slice(0, needLen);
    }

    /**
     * 甩牌垫牌时的补牌策略
     * - 队友在赢：优先垫最大的分牌跑分，再垫非分牌，最后主牌
     * - 对手在赢：优先垫最小非分牌，再垫分牌，最后主牌
     */
    _padThrowCards(result, used, needLen, otherNonTrumps, trumps, iAmWinning) {
        if (iAmWinning) {
            // 队友在赢 → 疯狂垫分数！
            const pointCards = otherNonTrumps.filter(c => this._isPointCard(c) && !used.has(c.id));
            const nonPointCards = otherNonTrumps.filter(c => !this._isPointCard(c) && !used.has(c.id));

            // 先垫最大的分牌
            for (let i = pointCards.length - 1; i >= 0 && result.length < needLen; i--) {
                result.push(pointCards[i]);
                used.add(pointCards[i].id);
            }
            // 再垫非分牌
            for (const card of nonPointCards) {
                if (result.length >= needLen) break;
                result.push(card);
                used.add(card.id);
            }
            // 最后垫主牌（包括主牌分牌也可以垫）
            for (const card of trumps) {
                if (result.length >= needLen) break;
                if (!used.has(card.id)) {
                    result.push(card);
                    used.add(card.id);
                }
            }
        } else {
            // 对手在赢 → 垫非分小牌
            const safeCards = otherNonTrumps.filter(c => !this._isPointCard(c) && !used.has(c.id));
            const pointCards = otherNonTrumps.filter(c => this._isPointCard(c) && !used.has(c.id));

            for (const card of safeCards) {
                if (result.length >= needLen) break;
                result.push(card);
                used.add(card.id);
            }
            for (const card of pointCards) {
                if (result.length >= needLen) break;
                result.push(card);
                used.add(card.id);
            }
            for (const card of trumps) {
                if (result.length >= needLen) break;
                if (!used.has(card.id)) {
                    result.push(card);
                    used.add(card.id);
                }
            }
        }
    }

    /**
     * 断门时甩牌垫牌（不杀）
     * - 队友在赢：疯狂垫大分数！断门后找出所有大分数
     * - 对手在赢：垫非分小牌 → 分牌 → 主牌
     */
    _discardThrow(nonTrumps, trumps, needLen, iAmWinning) {
        const result = [];
        const used = new Set();

        if (iAmWinning) {
            // 队友甩牌，对方杀不动 → 疯狂垫分数！
            const pointCards = nonTrumps.filter(c => this._isPointCard(c));
            const nonPointCards = nonTrumps.filter(c => !this._isPointCard(c));

            // 先垫最大的分数牌
            for (let i = pointCards.length - 1; i >= 0 && result.length < needLen; i--) {
                result.push(pointCards[i]);
                used.add(pointCards[i].id);
            }
            // 再垫非分牌
            for (const card of nonPointCards) {
                if (result.length >= needLen) break;
                if (!used.has(card.id)) {
                    result.push(card);
                    used.add(card.id);
                }
            }
            // 最后垫主牌（主牌分牌也可以垫，归根到底是抓分跑分游戏）
            for (const card of trumps) {
                if (result.length >= needLen) break;
                if (!used.has(card.id)) {
                    result.push(card);
                    used.add(card.id);
                }
            }
        } else {
            // 对手甩牌，杀不了 → 垫非分小牌
            const safeCards = nonTrumps.filter(c => !this._isPointCard(c));
            const pointCards = nonTrumps.filter(c => this._isPointCard(c));

            for (const card of safeCards) {
                if (result.length >= needLen) break;
                result.push(card);
                used.add(card.id);
            }
            for (const card of pointCards) {
                if (result.length >= needLen) break;
                result.push(card);
                used.add(card.id);
            }
            for (const card of trumps) {
                if (result.length >= needLen) break;
                if (!used.has(card.id)) {
                    result.push(card);
                    used.add(card.id);
                }
            }
        }

        return result.slice(0, needLen);
    }

    /**
     * 用全主牌杀甩牌
     *
     * 杀甩牌条件：全主牌 + 张数相同 + 对子数≥甩牌对子数
     * 如果已有人杀过，需要最大主牌 > 已杀的最大主牌
     *
     * 策略：
     *   - 优先用主牌分牌（既赢又拿分）
     *   - 确保对子数足够
     *   - 确保最大主牌能超越已有杀牌（如果有的话）
     *
     * @returns {Array|null} 杀牌数组，或null（杀不了）
     */
    _killThrow(trumps, leadTractorCount, leadPairCount, needLen, trumpSuit, level, trickCards) {
        // 修正：使用analyzeCardStructure进行拖拉机+对子匹配
        const struct = analyzeCardStructure(trumps, trumpSuit, level);
        const tractors = struct.tractors;
        const pairs = struct.pairs;
        const singles = struct.singles;

        // 检查是否已有杀牌（当前赢家不是甩牌者）
        const currentWinner = getTrickWinner(trickCards, trumpSuit, level, this.memory.playedCards);
        const winnerIsThrower = currentWinner.player === trickCards[0].player;
        const needBeatValue = winnerIsThrower ? -1 :
            Math.max(...currentWinner.cards.map(c => getCardValue(c, trumpSuit, level)));

        const result = [];
        const used = new Set();

        // 1. 先用拖拉机匹配甩牌中的拖拉机（优先大的拖拉机）
        const sortedTractors = [...tractors].sort((a, b) => {
            const maxA = Math.max(...a.map(c => getCardValue(c, trumpSuit, level)));
            const maxB = Math.max(...b.map(c => getCardValue(c, trumpSuit, level)));
            return maxB - maxA;
        });
        let tractorsUsed = 0;
        for (const tractor of sortedTractors) {
            if (tractorsUsed >= leadTractorCount) break;
            if (result.length + tractor.length > needLen) break;
            result.push(...tractor);
            tractor.forEach(c => used.add(c.id));
            tractorsUsed++;
        }

        // 2. 用对子匹配甩牌中的对子（优先大的对子）
        const sortedPairs = [...pairs].sort((a, b) =>
            getCardValue(b[0], trumpSuit, level) - getCardValue(a[0], trumpSuit, level)
        );
        let pairsUsed = 0;
        for (const pair of sortedPairs) {
            if (pairsUsed >= leadPairCount) break;
            if (result.length + 2 > needLen) break;
            if (used.has(pair[0].id) || used.has(pair[1].id)) continue;
            result.push(...pair);
            used.add(pair[0].id);
            used.add(pair[1].id);
            pairsUsed++;
        }

        // 3. 用单张主牌补足（优先分牌，再优先大的）
        const remaining = singles.filter(c => !used.has(c.id));
        const pointSingles = remaining.filter(c => this._isPointCard(c))
            .sort((a, b) => getCardValue(b, trumpSuit, level) - getCardValue(a, trumpSuit, level));
        const nonPointSingles = remaining.filter(c => !this._isPointCard(c))
            .sort((a, b) => getCardValue(b, trumpSuit, level) - getCardValue(a, trumpSuit, level));

        for (const card of pointSingles) {
            if (result.length >= needLen) break;
            result.push(card);
            used.add(card.id);
        }
        for (const card of nonPointSingles) {
            if (result.length >= needLen) break;
            result.push(card);
            used.add(card.id);
        }

        // 验证：拖拉机数和对子数是否足够
        const resultStruct = analyzeCardStructure(result, trumpSuit, level);
        if (resultStruct.tractors.length < leadTractorCount ||
            resultStruct.pairs.length < leadPairCount) return null;

        // 验证：毙杀强度是否能超越已有杀牌
        if (!winnerIsThrower) {
            if (compareKillStrength(result, currentWinner.cards, trumpSuit, level) <= 0) return null;
        }

        return result.slice(0, needLen);
    }

    /**
     * 用主牌杀
     * 优先用主牌分牌（既赢牌又拿分），其次用最小的能赢的主牌
     * 返回null表示无法用主牌杀（没有对应牌型），调用方需回退到垫牌
     */
    _killWithTrump(trumps, leadPattern, trickCards, trumpSuit, level, needLen) {
        if (leadPattern.type === 'single') {
            // 优先用主牌分牌杀（♠5、♠10、♠K等主花色分牌）
            const trumpPointCards = trumps.filter(c => this._isPointCard(c));
            if (trumpPointCards.length > 0) {
                // 找最小的能赢的主牌分牌
                const winner = getTrickWinner(trickCards, trumpSuit, level, this.memory.playedCards);
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
            // 杀对子必须有主牌对子，没有对子返回null（回退垫牌）
            const pairs = this._findPairs(trumps, trumpSuit, level);
            if (pairs.length === 0) return null;

            // 优先用含分牌的对子
            const pointPairs = pairs.filter(p => p.some(c => this._isPointCard(c)));
            if (pointPairs.length > 0) {
                const winner = getTrickWinner(trickCards, trumpSuit, level, this.memory.playedCards);
                const winnerCard = winner.cards[0];
                const winnerIsTrump = isTrump(winnerCard, trumpSuit, level);
                if (!winnerIsTrump) return pointPairs[0];
                const winnerValue = getCardValue(winnerCard, trumpSuit, level);
                for (const pair of pointPairs) {
                    if (getCardValue(pair[0], trumpSuit, level) > winnerValue) return pair;
                }
            }
            return this._findMinWinningPair(pairs, trickCards, trumpSuit, level);
        }

        if (leadPattern.type === 'tractor') {
            // 杀拖拉机必须有主牌拖拉机，没有返回null
            const tractors = this._findTractors(trumps, trumpSuit, level);
            const matching = tractors.find(t => t.length >= needLen);
            if (matching) return matching.slice(0, needLen);
            // 没有拖拉机但有对子，可以用对子拼（仍需同型）
            const pairs = this._findPairs(trumps, trumpSuit, level);
            if (pairs.length >= needLen / 2) {
                const result = [];
                for (const pair of pairs) {
                    result.push(...pair);
                    if (result.length >= needLen) break;
                }
                return result.slice(0, needLen);
            }
            return null; // 无法同型杀，回退垫牌
        }

        return [trumps[0]];
    }

    /**
     * 垫牌（不杀主时）
     * 优先垫最小的非分牌，不够再垫分牌，最后垫主牌
     * 确保返回的牌不重复，且数量足够
     */
    _discardCards(nonTrumps, trumps, needLen) {
        const safeCards = nonTrumps.filter(c => !this._isPointCard(c));
        const result = [];
        const used = new Set();

        // 1. 先垫最小的非分牌
        for (const card of safeCards) {
            if (result.length >= needLen) break;
            result.push(card);
            used.add(card.id);
        }

        // 2. 不够，垫最小的分牌
        if (result.length < needLen) {
            const pointCards = nonTrumps.filter(c => this._isPointCard(c) && !used.has(c.id));
            for (const card of pointCards) {
                if (result.length >= needLen) break;
                result.push(card);
                used.add(card.id);
            }
        }

        // 3. 还不够，垫最小的主牌
        if (result.length < needLen) {
            for (const card of trumps) {
                if (result.length >= needLen) break;
                if (!used.has(card.id)) {
                    result.push(card);
                    used.add(card.id);
                }
            }
        }

        return result.slice(0, needLen);
    }

    /**
     * 找最小的能赢过当前牌的主牌（单张）
     */
    _findMinWinningTrump(trumps, trickCards, trumpSuit, level, leadPattern) {
        const currentWinner = getTrickWinner(trickCards, trumpSuit, level, this.memory.playedCards);
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
        const currentWinner = getTrickWinner(trickCards, trumpSuit, level, this.memory.playedCards);
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
     *
     * 【强势牌计分制】
     * 手上有副牌A、JQK大对子、拖拉机等强势牌时，每一张牌算1分；
     * 只要强势牌总分 ≥ 2 分，即值得抢到出牌权。
     *
     * 抢到出牌权后的出牌原则（由 _leadWithStrength 等首家策略落地）：
     *   - 优先走绝对大牌（副牌A 等）；
     *   - JQK 对子要分情况看是否"绝对大牌"（结合已出大牌记忆判断，
     *     若该花色更大的对子已出完则当前JQK对子即为绝对大牌，否则谨慎）。
     *
     * 注意：仅统计"非当前出牌花色"的强势牌（当前花色因断门无法直接走）。
     *
     * @returns {boolean}
     */
    _wantControl(hand, trumpSuit, level, currentLeadSuit) {
        if (!hand) return false;

        const nonTrumps = hand.filter(c => !isTrump(c, trumpSuit, level));
        const suitGroups = {};
        for (const suit of [SUITS.SPADES, SUITS.HEARTS, SUITS.CLUBS, SUITS.DIAMONDS]) {
            suitGroups[suit] = nonTrumps.filter(c => c.suit === suit);
        }

        let strengthScore = 0;

        for (const suit of Object.keys(suitGroups)) {
            if (suit === currentLeadSuit) continue;
            const cards = suitGroups[suit];

            // 副牌A：每张A算1分
            const aces = cards.filter(c => c.rank === 'A');
            strengthScore += aces.length;

            // JQK大对子：对子里每张牌算1分（即一个对子=2分）
            // 仅用于判断"是否值得抢权"；抢到出牌权后是否走该对子，
            // 由首家策略根据"是否绝对大牌"分情况判断。
            const pairs = this._findPairs(cards, trumpSuit, level);
            for (const pair of pairs) {
                if (['J', 'Q', 'K'].includes(pair[0].rank)) {
                    strengthScore += pair.length; // 每张牌1分
                }
            }

            // 拖拉机：每张牌算1分
            const tractors = this._findTractors(cards, trumpSuit, level);
            for (const tractor of tractors) {
                strengthScore += tractor.length;
            }
        }

        // 只要强势牌总分≥2分，即值得抢到出牌权
        return strengthScore >= 2;
    }

    /**
     * 判断是否有强势主牌可以上手后主动打出（控场消耗策略）
     *
     * 主牌强势（有好几个对子甚至拖拉机，张数也多）时，上手后主动打出
     * 强势主牌，让其他玩家主牌断门，建立"只有我有主牌"的控场优势。
     * 此时断门杀牌抢出牌权非常有价值。
     *
     * @param {Array} trumps - 当前手牌中的主牌
     * @param {Array} hand - 当前手牌
     * @returns {boolean}
     */
    _hasStrongTrumpToLead(trumps, hand, trumpSuit, level) {
        if (!trumps || trumps.length === 0) return false;
        const pairs = this._findPairs(trumps, trumpSuit, level);
        const tractors = this._findTractors(trumps, trumpSuit, level);
        // 有拖拉机或2+对子，且主牌占手牌相当比例 → 强势主牌，值得抢权主动出主消耗
        if ((tractors.length > 0 || pairs.length >= 2) && trumps.length >= hand.length * 0.4) {
            return true;
        }
        // 主牌数量绝对优势（过半手牌是主）→ 主动出主消耗对手
        if (trumps.length >= hand.length * 0.55 && trumps.length >= 8) {
            return true;
        }
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
                if (isCardPair(cards[i], cards[j], trumpSuit, level)) {
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
     * 支持主牌跨类型拖拉机（主对+级牌对、级牌主对+小王对、小王对+大王对）
     */
    _findBestTractor(cards, trumpSuit, level) {
        const pairs = this._findPairs(cards, trumpSuit, level);
        if (pairs.length < 2) return null;

        const tractors = this._findTractorsFromPairs(pairs, trumpSuit, level);
        if (tractors.length > 0) return tractors[0];
        return null;
    }

    /**
     * 找出所有拖拉机
     * 支持主牌跨类型拖拉机
     */
    _findTractors(cards, trumpSuit, level) {
        const pairs = this._findPairs(cards, trumpSuit, level);
        if (pairs.length < 2) return [];
        return this._findTractorsFromPairs(pairs, trumpSuit, level);
    }

    /**
     * 从已排序的对子列表中找出所有拖拉机（连对）
     * 相邻对子的value差为1即为拖拉机
     * 副牌拖拉机还需同花色，主牌拖拉机跨类型不需要
     */
    _findTractorsFromPairs(pairs, trumpSuit, level) {
        // 确保按value排序
        pairs.sort((a, b) =>
            getCardValue(a[0], trumpSuit, level) - getCardValue(b[0], trumpSuit, level)
        );

        const tractors = [];
        for (let i = 0; i < pairs.length - 1; i++) {
            let sequence = [pairs[i]];
            for (let j = i + 1; j < pairs.length; j++) {
                const prevVal = getCardValue(sequence[sequence.length - 1][0], trumpSuit, level);
                const currVal = getCardValue(pairs[j][0], trumpSuit, level);
                if (currVal - prevVal === 1) {
                    // 检查副牌拖拉机需要同花色，主牌拖拉机不需要
                    const prevAllTrump = sequence[sequence.length - 1].every(c => isTrump(c, trumpSuit, level));
                    const currAllTrump = pairs[j].every(c => isTrump(c, trumpSuit, level));
                    if (prevAllTrump || currAllTrump ||
                        sequence[sequence.length - 1][0].suit === pairs[j][0].suit) {
                        sequence.push(pairs[j]);
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
            if (sequence.length >= 2) {
                tractors.push(sequence.flat());
            }
        }
        return tractors;
    }

    // ================================================================
    //  AI增强工具函数（基于tractor_AI文档策略）
    // ================================================================

    /**
     * 跑分时选择最优分牌：优先10（分值高），其次K（分值高但可留做绝对大牌），最后5（分值较低）
     * AI文档："优先跑10（分值高），其次跑K（分值高，本可留着走完A成为绝对大牌），最次跑5（分值较低）"
     */
    _getRunScoreCard(cards) {
        const pointCards = cards.filter(c => this._isPointCard(c));
        if (pointCards.length === 0) return null;
        // 优先级：10 > K > 5
        const priority = { '10': 3, 'K': 2, '5': 1 };
        pointCards.sort((a, b) => (priority[b.rank] || 0) - (priority[a.rank] || 0));
        return pointCards[0];
    }

    /**
     * 被迫垫分牌时选择最优分牌：优先5（分值最低），其次10，最后K（分值最高，尽量保留）
     * AI文档："先跟5，再跟10,最后选择是跟K"
     */
    _getDiscardScoreCard(cards) {
        const pointCards = cards.filter(c => this._isPointCard(c));
        if (pointCards.length === 0) return null;
        // 优先级：5 > 10 > K（先出分值低的）
        const priority = { '5': 3, '10': 2, 'K': 1 };
        pointCards.sort((a, b) => (priority[b.rank] || 0) - (priority[a.rank] || 0));
        return pointCards[0];
    }

    /**
     * 从数组中随机选择一个元素（防止行为可预测）
     * 截图建议："多个策略评分相等时，需引入随机选择"
     */
    _pickRandom(arr) {
        if (!arr || arr.length === 0) return null;
        if (arr.length === 1) return arr[0];
        return arr[Math.floor(Math.random() * arr.length)];
    }

    /**
     * 获取当前出牌位置（1=首家, 2=次家, 3=三家, 4=四家）
     * AI文档核心策略基于位置：次家灵活（队友四家可补救），三家是本方最后一手，四家决定胜负
     */
    _getPosition(trickCards) {
        return trickCards.length + 1; // trickCards已出的牌数+1
    }

    /**
     * 判断自己是否是首家（trickCards为空时）
     */
    _isLeader(trickCards) {
        return trickCards.length === 0;
    }

    /**
     * 判断当前是否接近终局（剩余5张牌以内，考虑抠底保底策略）
     * AI文档："应该在倒数剩5张牌开始，战略性考虑抠底保底的策略"
     */
    _isBottomGamePhase(hand) {
        return hand.length <= 5;
    }

    /**
     * 判断是否应跳过保底策略
     *
     * 当底牌分数为0或5分时，拖拉机抠底/甩牌抠底的概率极低：
     *   - 埋0分：无分可抠，完全不需要保底
     *   - 埋5分：最坏情况对抠仅20分，不值得为此损失当前出牌利益
     *
     * 只有庄家AI知道底牌分数（通过decideBury记录）。
     * 闲家AI或玩家埋底时bottomPoints为null，不跳过（保持原有策略）。
     */
    _shouldSkipBottomProtection() {
        return this.memory.bottomPoints !== null && this.memory.bottomPoints <= 5;
    }

    /**
     * 判断是否是最后一手牌（决定抠底倍数）
     */
    _isLastHand(hand, leadPattern) {
        return hand.length === leadPattern.length;
    }

    /**
     * 判断自己是否有能力在最后一轮赢牌（用于抠底/保底策略）
     * 需要：大王、或小王+大王已出、或强势主牌组合
     */
    _canWinLastHand(hand, trumpSuit, level) {
        if (this._hasBigJoker(hand)) return true;
        if (this._hasSmallJoker(hand) && this._bigJokersPlayed() >= 2) return true;
        const trumps = hand.filter(c => isTrump(c, trumpSuit, level));
        const tractors = this._findTractors(trumps, trumpSuit, level);
        if (tractors.length > 0) return true;
        const pairs = this._findPairs(trumps, trumpSuit, level);
        if (pairs.length >= 2) return true;
        return false;
    }

    /**
     * 评估手牌的抠底能力（用于闲家判断是否值得追求抠底）
     * 返回：甩主牌 > 甩副牌 > 拖拉机 > 对子 > 单张
     */
    _evaluateDigBottomPotential(hand, trumpSuit, level) {
        const trumps = hand.filter(c => isTrump(c, trumpSuit, level));
        const tractors = this._findTractors(trumps, trumpSuit, level);
        const pairs = this._findPairs(trumps, trumpSuit, level);
        const hasBigJoker = this._hasBigJoker(hand);
        const hasSmallJoker = this._hasSmallJoker(hand);

        let score = 0;
        // 大王是抠底的关键
        if (hasBigJoker) score += 50;
        if (hasSmallJoker) score += 20;
        // 拖拉机可以高倍抠底
        score += tractors.length * 30;
        // 对子可以中等倍率抠底
        score += pairs.length * 10;
        // 主牌数量
        score += Math.min(trumps.length, 10);
        return score;
    }

    /**
     * 终局最后一手牌策略：保底/抠底
     *
     * 最后一手牌的赢家获得底牌分数，倍数由牌型决定：
     *   单张×2, 对子×4, 拖拉机×8, 甩牌×(张数×2)
     *
     * 庄家方（保底）：必须赢最后一手，不惜用大王
     *   AI文档："用大王抠底或保底"——大王先出先大原则
     *
     * 闲家方（抠底）：尽量赢最后一手，且争取多张牌型提高倍数
     *   AI文档："制造出最后一手多张牌一把出尽且保证赢下该轮的可能性"
     *   "常见排名：甩主牌>甩副牌>拖拉机>对子"
     */
    _bottomPhaseLastHand(hand, trumps, leadPattern, leadSuit, trickCards, iAmWinning,
                          trickScore, trumpSuit, level, isDealerTeam, isLastPlayer) {
        const needLen = leadPattern.length;

        // 队友在赢 → 不抢，配合跑分或保留
        if (iAmWinning) {
            // 队友赢最后一手 = 保底/抠底成功
            // 如果是庄家方：队友保底成功，贴分牌跑分
            // 如果是闲家方：队友抠底成功，贴分牌加大抠底收益
            if (isLastPlayer) {
                // 最后一家，队友赢，尽可能多贴分牌
                const allCards = this._sortByValue([...hand], trumpSuit, level);
                const result = [];
                // 先贴分牌（优先10>K>5跑分）
                for (let i = 0; i < needLen && allCards.length > 0; i++) {
                    const runCard = this._getRunScoreCard(allCards);
                    if (runCard) {
                        result.push(runCard);
                        allCards.splice(allCards.indexOf(runCard), 1);
                    } else {
                        // 没分牌了，贴最小的
                        const nonPoint = allCards.filter(c => !this._isPointCard(c));
                        if (nonPoint.length > 0) {
                            result.push(nonPoint[0]);
                            allCards.splice(allCards.indexOf(nonPoint[0]), 1);
                        } else {
                            result.push(allCards[0]);
                            allCards.shift();
                        }
                    }
                }
                return result;
            }
            return null; // 非最后一家，交给常规策略
        }

        // 对手在赢 → 必须想办法赢回来
        // 底牌≤5分时跳过保底杀牌：拖拉机抠底/甩牌抠底概率极低，
        // 埋5分被对抠也就20分，不值得用大王等大牌去保底
        if (this._shouldSkipBottomProtection()) {
            return null; // 交给常规跟牌策略
        }

        // 有主牌且能同型杀 → 杀！
        if (trumps.length >= needLen) {
            // 检查能否同型杀
            let canKill = false;
            if (leadPattern.type === 'single') {
                canKill = true;
            } else if (leadPattern.type === 'pair') {
                canKill = this._findPairs(trumps, trumpSuit, level).length > 0;
            } else if (leadPattern.type === 'tractor') {
                canKill = this._findTractors(trumps, trumpSuit, level).length > 0;
            } else if (leadPattern.type === 'throw') {
                const leadStruct = analyzeCardStructure(trickCards[0].cards, trumpSuit, level);
                const trumpStruct = analyzeCardStructure(trumps, trumpSuit, level);
                canKill = trumpStruct.tractors.length >= leadStruct.tractors.length &&
                          trumpStruct.pairs.length >= leadStruct.pairs.length;
            }

            if (canKill) {
                // 最后一手，不惜代价杀！用最大的主牌确保赢
                const killCards = this._killWithTrump(trumps, leadPattern, trickCards, trumpSuit, level, needLen);
                if (killCards) {
                    this._debug(`终局最后一手：${isDealerTeam ? '保底' : '抠底'}杀牌`);
                    return killCards;
                }
            }
            // 单张时直接用最大的主牌杀
            if (leadPattern.type === 'single' && trumps.length > 0) {
                const winner = getTrickWinner(trickCards, trumpSuit, level, this.memory.playedCards);
                const winnerValue = getCardValue(winner.cards[0], trumpSuit, level);
                for (let i = trumps.length - 1; i >= 0; i--) {
                    if (getCardValue(trumps[i], trumpSuit, level) > winnerValue) {
                        this._debug(`终局最后一手：${isDealerTeam ? '保底' : '抠底'}用大主牌杀`);
                        return [trumps[i]];
                    }
                }
            }
        }

        // 有同花色牌 → 尝试用最大的赢
        if (leadSuit) {
            const leadSuitCards = this._sortByValue(
                hand.filter(c => !c.isJoker && c.suit === leadSuit && !isTrump(c, trumpSuit, level)),
                trumpSuit, level
            );
            if (leadSuitCards.length >= needLen) {
                const winner = getTrickWinner(trickCards, trumpSuit, level, this.memory.playedCards);
                const winnerCard = winner.cards[0];
                const winnerIsTrump = isTrump(winnerCard, trumpSuit, level);
                if (!winnerIsTrump) {
                    // 对手用副牌赢，看能不能用更大的副牌赢
                    if (leadPattern.type === 'single') {
                        const winnerValue = getCardValue(winnerCard, trumpSuit, level);
                        for (let i = leadSuitCards.length - 1; i >= 0; i--) {
                            if (getCardValue(leadSuitCards[i], trumpSuit, level) > winnerValue) {
                                this._debug(`终局最后一手：用大牌赢保底/抠底`);
                                return [leadSuitCards[i]];
                            }
                        }
                    }
                }
            }
        }

        return null; // 无法赢，交给常规策略
    }

    /**
     * 终局保底/抠底策略：倒数几手的出牌权争夺
     *
     * 庄家方（保底）：对手在赢时，如有主牌则杀，防止对手拿到出牌权控制最后一手
     *   AI文档："保住底牌分数十分关键"
     *
     * 闲家方（抠底）：对手在赢时，评估是否值得杀
     *   - 有大王/小王 + 手中有强势多张组合 → 值得杀，抢出牌权为抠底做准备
     *   - 无强势组合 → 不浪费主牌，等更好的时机
     *   AI文档："制造出最后一手多张牌一把出尽且保证赢下该轮的可能性"
     */
    _bottomPhaseProtect(hand, trumps, leadPattern, leadSuit, trickCards, trickScore,
                         trumpSuit, level, isDealerTeam, isLastPlayer) {
        const needLen = leadPattern.length;

        // 庄家方：对手在赢 → 必须杀，保底优先
        if (isDealerTeam) {
            if (trumps.length >= needLen) {
                // 检查能否同型杀
                let canKill = false;
                if (leadPattern.type === 'single') {
                    canKill = true;
                } else if (leadPattern.type === 'pair') {
                    canKill = this._findPairs(trumps, trumpSuit, level).length > 0;
                } else if (leadPattern.type === 'tractor') {
                    canKill = this._findTractors(trumps, trumpSuit, level).length > 0;
                }

                if (canKill) {
                    const killCards = this._killWithTrump(trumps, leadPattern, trickCards, trumpSuit, level, needLen);
                    if (killCards) {
                        this._debug(`终局保底：杀牌防止闲家拿权`);
                        return killCards;
                    }
                }
            }
            return null; // 无法杀，交给常规策略
        }

        // 闲家方：评估抠底价值
        const digPotential = this._evaluateDigBottomPotential(hand, trumpSuit, level);
        // 有大王或较强主牌组合 → 值得抢权抠底
        if (digPotential >= 50 && trumps.length >= needLen) {
            let canKill = false;
            if (leadPattern.type === 'single') {
                canKill = true;
            } else if (leadPattern.type === 'pair') {
                canKill = this._findPairs(trumps, trumpSuit, level).length > 0;
            } else if (leadPattern.type === 'tractor') {
                canKill = this._findTractors(trumps, trumpSuit, level).length > 0;
            }

            if (canKill) {
                const killCards = this._killWithTrump(trumps, leadPattern, trickCards, trumpSuit, level, needLen);
                if (killCards) {
                    this._debug(`终局抠底：抢出牌权（抠底潜力${digPotential}）`);
                    return killCards;
                }
            }
        }

        return null; // 不值得抢权，交给常规策略
    }

    /**
     * 调试日志输出
     * 截图建议："建议增加DEBUG开关，输出AI每一步的评分和选择理由"
     */
    _debug(msg) {
        if (typeof DEBUG !== 'undefined' && DEBUG) {
            console.log(`[AI:${this.position}] ${msg}`);
        }
    }

    /**
     * 检查某牌型是否曾经甩错（避免AI重复甩错）
     * 截图建议："AI应避免再次甩错，需记录该牌型不可再试"
     */
    _hasFailedThrow(cards, trumpSuit, level) {
        if (!this.memory.failedThrows) return false;
        const failKey = cards.map(c => `${c.suit}-${c.rank}`).sort().join(',');
        return this.memory.failedThrows.some(f => f.key === failKey);
    }

    /**
     * 判断对手是否大概率已断某门花色
     * 基于记牌：如果该花色已出的牌加上自己手里的牌接近2副牌的总量
     */
    _isOpponentLikelyVoid(suit, trumpSuit, level, hand) {
        if (isTrump({ suit, rank: 'A', isJoker: false }, trumpSuit, level)) return false;
        const myCards = hand.filter(c => c.suit === suit && !isTrump(c, trumpSuit, level));
        const playedCount = this._countPlayedSuit(suit, trumpSuit, level);
        const totalCards = 26; // 2副牌×13张，减去级牌(2张×2副=4张) = 22，但保守用26
        const remaining = totalCards - playedCount - myCards.length;
        // 如果剩余很少且分散在3家手中，对手大概率断门
        return remaining <= 3;
    }
}

// 创建AI实例
const aiPlayers = {
    left: new TractorAI('left'),
    top: new TractorAI('top'),
    right: new TractorAI('right')
};

// Node.js 模块导出（浏览器环境自动忽略）
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TractorAI;
}
