# CBB vs NBA: Shock-Fade Strategy Analysis

*Generated 2026-02-09 from recorded data (Feb 7-9)*

## Executive Summary

**CBB is a WORSE opportunity than NBA for shock-fade**, primarily due to **10x thinner order books** despite having comparable trade frequency. However, CBB has **more scoring events per game** and **larger price shocks** — the edges exist, but fill probability is the bottleneck.

**Recommendation: Keep recording, don't enable for live trading yet.** The thin books mean our 35-share ladder may not fill reliably on small-market games. The top-tier CBB games (USC-Penn St, Texas Tech-WVU) have enough depth, but bottom-tier games (Navy-Bucknell) absolutely do not.

---

## 1. Trade Volume & Liquidity

### Per-Game Trade Counts

| Game | Trades | Avg Trade Size | Total $ Volume |
|------|--------|---------------|----------------|
| **NBA** HOU@OKC | 816,880 | 13,607 shares | $5.56B |
| **NBA** GSW@LAL | 549,460 | 17,580 shares | $4.83B |
| **NBA** MEM@POR | 703,538 | — | — |
| **NBA** DEN@CHI | 516,804 | 11,054 shares | $2.86B |
| **NBA** CLE@SAC | 549,224 | — | — |
| --- | --- | --- | --- |
| **CBB** USC-PennSt | 346,746 | 2,476 shares | $429M |
| **CBB** Tulsa-SFL | 287,612 | 1,868 shares | $269M |
| **CBB** Mary-MinnSt | 222,212 | — | — |
| **CBB** NCG-Furman | 194,708 | 676 shares | $66M |
| **CBB** Navy-Bucknell | 191,892 | — | — |
| **CBB** UCF-Cin | 135,784 | — | — |
| **CBB** TxTech-WVU | 110,979 | 2,915 shares | $162M |
| **CBB** Mich-OhioSt | 92,134 | — | — |
| **CBB** Arizona-Kansas | 69,096 | — | — |

### Key Findings
- **NBA avg trades/game: ~627K** | **CBB avg: ~182K** (3.4x less)
- **NBA avg trade size: ~14,000 shares** | **CBB avg: ~2,100 shares** (6.7x smaller)
- **NBA avg $ volume/game: ~$4.4B** | **CBB avg: ~$175M** (25x less)
- CBB has massive variance: top games (USC-PennSt) are 5x bigger than bottom (Arizona-Kansas)

## 2. Order Book Depth

### Best Level (Level 1) — Average Bid/Ask Size

| Market | Avg Bid | Avg Ask | Spread | Can fill 35 shares? |
|--------|---------|---------|--------|---------------------|
| **NBA** HOU@OKC | 48,014 | 47,836 | 1.2¢ | ✅ Trivially |
| **NBA** DEN@CHI | 38,295 | 38,441 | 1.2¢ | ✅ Trivially |
| **NBA** GSW@LAL | 76,035 | 76,048 | 1.1¢ | ✅ Trivially |
| --- | --- | --- | --- | --- |
| **CBB** TxTech-WVU | 5,000 | 5,000 | 1.5¢ | ✅ Yes |
| **CBB** USC-PennSt | 4,656 | 4,663 | 1.8¢ | ✅ Yes |
| **CBB** NCG-Furman | 407 | 407 | 2.3¢ | ✅ Barely |
| **CBB** Navy-Bucknell | 176 | 176 | 3.4¢ | ⚠️ Risky |

### Cumulative Depth (Levels 1-3, covers our 3¢ ladder spacing)

| Market | Cum Ask (3 levels) | 35 shares fill? |
|--------|-------------------|-----------------|
| **CBB** TxTech-WVU | 13,649 | ✅ |
| **CBB** USC-PennSt | 10,707 | ✅ |
| **CBB** NCG-Furman | 1,907 | ✅ |
| **CBB** Navy-Bucknell | 1,511 | ✅ |

### Key Findings
- **NBA books are 10-400x deeper** than CBB at best level
- **Top-tier CBB (TxTech, USC): 5,000 shares at best** — our 35-share ladder is invisible, fills easily
- **Bottom-tier CBB (Navy-Bucknell): 176 shares at best** — our 35-share ladder is 20% of the book
- **CBB spreads wider: 1.5-3.4¢** vs NBA's 1.1-1.2¢ — eating into our 3¢ TP target
- Even bottom-tier cumulative depth (1,511) easily covers 35 shares across 3 levels

## 3. Scoring Events & Shock Behavior

### Scoring Frequency

| Game | Unique Scoring Events | Per-Minute (est.) |
|------|----------------------|-------------------|
| **CBB** UCF-Cin | 142 | ~3.6/min |
| **CBB** USC-PennSt | 135 | ~3.4/min |
| **CBB** TxTech-WVU | 119 | ~3.0/min |
| **NBA** DEN@CHI | 111 | ~2.3/min |
| **NBA** HOU@OKC | 101 | ~2.1/min |
| **NBA** GSW@LAL | 91 | ~1.9/min |

### Shock-Fade Behavior (from sub-agent analysis)

**CBB** (cbb-usc-pennst): Avg shock = **7.46¢**, fades ~4.7¢ within 30-60s
**CBB** (cbb-ucf-cin): Avg shock = **27.8¢**, fades ~6.2¢ within 30-60s, ~9.5¢ within 60-120s
**NBA** (nba-hou-okc): Avg shock = **7.7¢**, fades ~7.1¢ within 30-60s (clean)
**NBA** (nba-cle-sac): Avg shock = **15.5¢**, price CONTINUES moving (negative fade)

### Key Findings
- **CBB has ~50% more scoring events** per game (130 vs 100)
- **CBB shocks are LARGER** — prices overshoot more, potentially due to thinner books
- **CBB fade-back is real** but less consistent than NBA
- More events + bigger shocks = more trading opportunities per game
- BUT: bigger shocks on thin books might mean our limit orders fill in the wrong direction

## 4. Bottom Line Comparison

| Factor | NBA | CBB | Winner |
|--------|-----|-----|--------|
| Book depth (best level) | 40-76K shares | 176-5,000 shares | **NBA** (10-400x) |
| Spread | 1.1-1.2¢ | 1.5-3.4¢ | **NBA** |
| Trades/game | 627K avg | 182K avg | **NBA** (3.4x) |
| Trade size | 14,000 shares | 2,100 shares | **NBA** (6.7x) |
| Scoring events | ~100/game | ~130/game | **CBB** |
| Shock magnitude | 7-16¢ | 7-28¢ | **CBB** (bigger = more opportunity) |
| Fade reliability | Clean | Mixed | **NBA** |
| Games per day | 5-10 | 15-40+ | **CBB** (3-4x) |
| Fill probability for 35 shares | ~100% | 90-99% top games, uncertain bottom | **NBA** |
| Competition (informed traders) | High | Lower | **CBB** |

## 5. Recommendation

### DON'T enable CBB for live trading yet. Here's why:

1. **Fill probability is the bottleneck.** We sell shares from splits (cost = $1/pair), so spread doesn't eat our edge — any sell above fair value is profit. But on thin books (Navy-Bucknell: 176 shares at best bid), there may not be enough buy pressure during shocks to fill our 5/10/20 ladder. One other bot could wipe the entire level.

2. **Top-tier CBB is viable but rare.** Only ~3-4 CBB games per day have NBA-level depth (5,000+ at best). The other 10+ are too thin for reliable fills.

### BUT: CBB has long-term potential

- **Less competition** — fewer sophisticated bots watching CBB shocks
- **More games** — even 3-4 viable per day doubles our opportunity vs NBA
- **Bigger shocks** — thin books = bigger overshoots = more to capture IF we can fill

### Recommended path forward:
1. **Keep recording** CBB data (already doing this ✅)
2. **Add a minimum depth filter**: only trade CBB games with >2,000 shares at best bid
3. **Reduce ladder sizes for CBB**: 2/5/10 instead of 5/10/20 (17 shares total vs 35)
4. **Wider TP for CBB**: 6-8¢ instead of 4¢ to compensate for wider spreads
5. **Enable after 2+ weeks of recording** to validate the depth filter catches enough games
