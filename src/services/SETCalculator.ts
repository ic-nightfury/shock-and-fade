/**
 * SET Calculator Service
 *
 * Standalone pure function to calculate triggerSize, hedgeSize, hedgePrice
 * given current position state and trigger price.
 *
 * Algorithm:
 *   1. Check if dilution needed (hedge side expensive)
 *   2. If dilution: calculate shares to avg down hedge, match on trigger
 *   3. If normal: deficit-aware trigger size, balance hedge size
 */

export interface SETCalculatorInput {
  triggerCurrentShare: number;   // Current shares on trigger side
  triggerCurrentAvg: number;     // Current avg price on trigger side (0 if no position)
  hedgeCurrentShare: number;     // Current shares on hedge side
  hedgeCurrentAvg: number;       // Current avg price on hedge side (0 if no position)
  triggerPrice: number;          // Price we're buying trigger at
  targetPairCost: number;        // Target pair cost ($0.98)
  baseSize?: number;             // Base order size (default 10)
}

export interface SETCalculatorOutput {
  triggerSize: number;
  hedgeSize: number;
  hedgePrice: number;
  mode: 'normal' | 'dilution';
}

export function calculateSET(input: SETCalculatorInput): SETCalculatorOutput {
  const {
    triggerCurrentShare,
    triggerCurrentAvg,
    hedgeCurrentShare,
    hedgeCurrentAvg,
    triggerPrice,
    targetPairCost,
    baseSize = 10
  } = input;

  // Derived values
  const triggerCost = triggerCurrentShare * triggerCurrentAvg;
  const hedgeCost = hedgeCurrentShare * hedgeCurrentAvg;
  const targetHedgeAvg = targetPairCost - triggerPrice;

  // === DILUTION PATH ===
  // When hedge side is more expensive than target, buy MORE at cheaper price to dilute
  // Algorithm:
  //   1. targetHedgeAvg = targetPairCost - triggerPrice
  //   2. hedgePrice = targetHedgeAvg - 0.20 (pending order, lower price)
  //   3. extraHedge = shares needed to avg down to targetHedgeAvg
  //   4. triggerSize = (hedgeQty + extraHedge) - triggerQty (to balance)
  if (hedgeCurrentShare > 0 && hedgeCurrentAvg > targetHedgeAvg + 0.01) {
    const dilutionHedgePrice = Math.max(0.05, targetHedgeAvg - 0.20);

    if (targetHedgeAvg > dilutionHedgePrice) {
      // Calculate extra hedge needed to dilute existing position
      // (hedgeCost + extraHedge * hedgePrice) / (hedgeQty + extraHedge) = targetHedgeAvg
      // Solving: extraHedge = (hedgeCost - targetHedgeAvg * hedgeQty) / (targetHedgeAvg - hedgePrice)
      const extraHedge = (hedgeCost - targetHedgeAvg * hedgeCurrentShare) / (targetHedgeAvg - dilutionHedgePrice);

      if (extraHedge > 0 && extraHedge <= 500) {
        const hedgeSize = Math.ceil(extraHedge);
        const newBalancedQty = hedgeCurrentShare + hedgeSize;
        const triggerSize = Math.max(newBalancedQty - triggerCurrentShare, baseSize);

        return {
          triggerSize,
          hedgeSize,
          hedgePrice: Math.round(dilutionHedgePrice * 100) / 100,
          mode: 'dilution'
        };
      }
    }
  }

  // === NORMAL PATH ===
  const imbalance = Math.abs(triggerCurrentShare - hedgeCurrentShare);
  const deficitOnTriggerSide = triggerCurrentShare < hedgeCurrentShare;

  // Trigger size: deficit-aware (size up when on deficit side)
  let triggerSize = baseSize;
  if (deficitOnTriggerSide && imbalance > 0) {
    triggerSize = Math.min(Math.max(baseSize, imbalance), 200);
  }

  // Hedge size: balance after trigger fills
  const projectedTriggerQty = triggerCurrentShare + triggerSize;
  const hedgeSize = Math.max(0, projectedTriggerQty - hedgeCurrentShare);

  // Hedge price: solve for target pair cost
  let hedgePrice: number;
  if (triggerCurrentShare === 0 && hedgeCurrentShare === 0) {
    // No position yet - simple calculation
    hedgePrice = targetPairCost - triggerPrice;
  } else {
    // Calculate projected avg trigger after fill
    const newTriggerCost = triggerCost + triggerSize * triggerPrice;
    const projectedAvgTrigger = newTriggerCost / projectedTriggerQty;

    // Solve for hedge price that achieves target pair cost
    const maxAvgHedge = targetPairCost - projectedAvgTrigger;
    const newHedgeQty = hedgeCurrentShare + hedgeSize;
    hedgePrice = hedgeSize > 0
      ? (maxAvgHedge * newHedgeQty - hedgeCost) / hedgeSize
      : 0.01;
  }

  return {
    triggerSize,
    hedgeSize,
    hedgePrice: Math.round(Math.max(0.01, hedgePrice) * 100) / 100,
    mode: 'normal'
  };
}
