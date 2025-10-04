const removeOutliers = (data, tolerance) => {
  // Step 1: Build frequency map of rounded differences
  const freqMap = {};

  for (const item of data) {
    const rounded = Math.round(item.difference * 10) / 10;
    freqMap[rounded] = (freqMap[rounded] || 0) + 1;
  }

  // Step 2: Find the mode (most common rounded value)
  let mode = null;
  let maxCount = -1;

  for (const [valueStr, count] of Object.entries(freqMap)) {
    const value = parseFloat(valueStr);
    if (count > maxCount) {
      maxCount = count;
      mode = value;
    }
  }

  // Step 3: Define bounds around the mode (±0.5)
  const lowerBound = mode - tolerance;
  const upperBound = mode + tolerance;

  // Step 4: Split data into good values and outliers
  const goodValues = data.filter(
    (item) => item.difference >= lowerBound && item.difference <= upperBound,
  );
  const outliers = data.filter(
    (item) => item.difference < lowerBound || item.difference > upperBound,
  );
  return goodValues;
};

export const weightedLinearRegression = (data, maxRateTolerance) => {
  const cleaned = removeOutliers(data, maxRateTolerance);
  let sumW = 0,
    sumWX = 0,
    sumWY = 0,
    sumWXY = 0,
    sumWXX = 0;

  for (const d of cleaned) {
    const w = d.correlation;
    const x = d.order;
    const y = d.difference;

    sumW += w;
    sumWX += w * x;
    sumWY += w * y;
    sumWXY += w * x * y;
    sumWXX += w * x * x;
  }

  const denominator = sumW * sumWXX - sumWX * sumWX;

  const slope = (sumW * sumWXY - sumWX * sumWY) / denominator;
  const intercept = (sumWY * sumWXX - sumWX * sumWXY) / denominator;

  return { slope, intercept };
};

export const simpleLinearRegression = (data, maxRateTolerance) => {
  const cleaned = removeOutliers(data, maxRateTolerance);
  const n = cleaned.length;
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0;

  for (const point of cleaned) {
    const x = point.order;
    const y = point.difference;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  return { slope, intercept };
};
