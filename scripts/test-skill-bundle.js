// Simple sentiment analysis skill — runs as L2 Worker
// Exported function matches the WorkerDispatch interface

exports.execute = async function execute(input) {
  const text = (input.text || input.prompt || input.content || "").toString().toLowerCase();

  if (!text) {
    return { error: "No text provided. Pass { text: '...' } as input." };
  }

  const positive = ["love", "great", "amazing", "excellent", "wonderful", "fantastic", "awesome", "good", "happy", "best", "perfect", "beautiful", "enjoy", "pleased", "satisfied", "recommend"];
  const negative = ["hate", "terrible", "awful", "horrible", "bad", "worst", "broken", "poor", "disappointing", "frustrated", "angry", "useless", "waste", "fail", "sucks", "rubbish"];

  const words = text.split(/\s+/);
  let positiveCount = 0;
  let negativeCount = 0;
  const positiveMatches = [];
  const negativeMatches = [];

  for (const word of words) {
    const clean = word.replace(/[^a-z]/g, "");
    if (positive.includes(clean)) { positiveCount++; positiveMatches.push(clean); }
    if (negative.includes(clean)) { negativeCount++; negativeMatches.push(clean); }
  }

  const total = positiveCount + negativeCount;
  let sentiment, score;

  if (total === 0) {
    sentiment = "neutral";
    score = 0.5;
  } else {
    score = positiveCount / total;
    sentiment = score > 0.6 ? "positive" : score < 0.4 ? "negative" : "mixed";
  }

  return {
    sentiment,
    score: Math.round(score * 100) / 100,
    positiveSignals: positiveMatches,
    negativeSignals: negativeMatches,
    wordCount: words.length,
    summary: `Detected ${sentiment} sentiment (score: ${score.toFixed(2)}). Found ${positiveCount} positive and ${negativeCount} negative signals.`,
  };
};

exports.metadata = {
  name: "emotion-state",
  version: "1.0.0",
  timeout: 5000,
};
