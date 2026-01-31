/**
 * Token Usage Tracking Service
 * Tracks AI API usage across all providers for cost analysis and debugging
 */

const STORAGE_KEY = 'resume-designer-token-usage';

// Pricing per 1M tokens (in USD)
// Sources: 
// - Anthropic: https://docs.anthropic.com/en/docs/about-claude/pricing
// - OpenAI: https://platform.openai.com/docs/pricing (Standard tier)
const PRICING = {
  anthropic: {
    // Claude Opus 4.5: $5 input, $25 output per MTok
    'claude-opus-4-5-20251101': { input: 5.00, output: 25.00 },
    // Claude Sonnet 4.5: $3 input, $15 output per MTok
    'claude-sonnet-4-5-20250929': { input: 3.00, output: 15.00 },
    // Claude Haiku 4.5: $1 input, $5 output per MTok
    'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 }
  },
  openai: {
    // GPT-5.2 Standard: $1.75 input, $14.00 output per 1M tokens
    'gpt-5.2': { input: 1.75, output: 14.00 },
    // GPT-5.2-pro Standard: $21.00 input, $168.00 output per 1M tokens
    'gpt-5.2-pro': { input: 21.00, output: 168.00 },
    // GPT-4o Standard: $2.50 input, $10.00 output per 1M tokens
    'gpt-4o': { input: 2.50, output: 10.00 },
    // GPT-4o-mini Standard: $0.15 input, $0.60 output per 1M tokens
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    // Search preview models
    'gpt-4o-search-preview': { input: 2.50, output: 10.00 },
    'gpt-4o-mini-search-preview': { input: 0.15, output: 0.60 }
  },
  gemini: {
    // Gemini pricing (estimated, check Google's pricing page for current rates)
    'gemini-3-pro': { input: 1.25, output: 5.00 },
    'gemini-3-flash': { input: 0.075, output: 0.30 },
    'gemini-2.0-flash': { input: 0.075, output: 0.30 },
    'gemini-1.5-pro': { input: 1.25, output: 5.00 }
  }
};

// Default storage structure
const DEFAULT_STORAGE = {
  events: [],
  summary: {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    byModel: {},
    byFeature: {}
  }
};

/**
 * Generate a unique ID for events
 */
function generateEventId() {
  return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Load usage data from localStorage
 */
export function loadUsageData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      // Ensure structure is valid
      return {
        events: data.events || [],
        summary: data.summary || { ...DEFAULT_STORAGE.summary }
      };
    }
  } catch (e) {
    console.error('[TokenTracking] Failed to load usage data:', e);
  }
  return { ...DEFAULT_STORAGE, summary: { ...DEFAULT_STORAGE.summary } };
}

/**
 * Save usage data to localStorage
 */
function saveUsageData(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    console.error('[TokenTracking] Failed to save usage data:', e);
    return false;
  }
}

/**
 * Calculate cost for a usage event
 */
export function calculateCost(provider, model, inputTokens, outputTokens) {
  const providerPricing = PRICING[provider];
  if (!providerPricing) {
    console.warn(`[TokenTracking] Unknown provider: ${provider}`);
    return 0;
  }
  
  const modelPricing = providerPricing[model];
  if (!modelPricing) {
    console.warn(`[TokenTracking] Unknown model: ${model} for provider ${provider}`);
    // Use a default/fallback pricing
    return 0;
  }
  
  // Price is per 1M tokens, so divide by 1,000,000
  const inputCost = (inputTokens / 1_000_000) * modelPricing.input;
  const outputCost = (outputTokens / 1_000_000) * modelPricing.output;
  
  return inputCost + outputCost;
}

/**
 * Track a usage event
 */
export function trackUsage({ provider, model, feature, inputTokens, outputTokens, cacheRead = 0, cacheCreation = 0 }) {
  const data = loadUsageData();
  
  const cost = calculateCost(provider, model, inputTokens, outputTokens);
  
  // Create event record
  const event = {
    id: generateEventId(),
    timestamp: new Date().toISOString(),
    provider,
    model,
    feature: feature || 'unknown',
    inputTokens: inputTokens || 0,
    outputTokens: outputTokens || 0,
    cacheRead: cacheRead || 0,
    cacheCreation: cacheCreation || 0,
    cost
  };
  
  // Add to events array
  data.events.push(event);
  
  // Update summary
  data.summary.totalInputTokens += event.inputTokens;
  data.summary.totalOutputTokens += event.outputTokens;
  data.summary.totalCost += cost;
  
  // Update by model
  const modelKey = `${provider}:${model}`;
  if (!data.summary.byModel[modelKey]) {
    data.summary.byModel[modelKey] = {
      provider,
      model,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      calls: 0
    };
  }
  data.summary.byModel[modelKey].inputTokens += event.inputTokens;
  data.summary.byModel[modelKey].outputTokens += event.outputTokens;
  data.summary.byModel[modelKey].cost += cost;
  data.summary.byModel[modelKey].calls += 1;
  
  // Update by feature
  if (!data.summary.byFeature[feature]) {
    data.summary.byFeature[feature] = {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      calls: 0
    };
  }
  data.summary.byFeature[feature].inputTokens += event.inputTokens;
  data.summary.byFeature[feature].outputTokens += event.outputTokens;
  data.summary.byFeature[feature].cost += cost;
  data.summary.byFeature[feature].calls += 1;
  
  // Save updated data
  saveUsageData(data);
  
  console.log(`[TokenTracking] Tracked: ${provider}/${model} - ${feature} - ${inputTokens} in / ${outputTokens} out - $${cost.toFixed(6)}`);
  
  return event;
}

/**
 * Get usage summary
 */
export function getUsageSummary() {
  const data = loadUsageData();
  return data.summary;
}

/**
 * Get all usage events
 */
export function getUsageEvents() {
  const data = loadUsageData();
  return data.events;
}

/**
 * Get usage by date (grouped by day)
 */
export function getUsageByDate() {
  const data = loadUsageData();
  const byDate = {};
  
  for (const event of data.events) {
    const date = event.timestamp.split('T')[0]; // Get YYYY-MM-DD
    if (!byDate[date]) {
      byDate[date] = {
        date,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        calls: 0
      };
    }
    byDate[date].inputTokens += event.inputTokens;
    byDate[date].outputTokens += event.outputTokens;
    byDate[date].cost += event.cost;
    byDate[date].calls += 1;
  }
  
  // Sort by date descending
  return Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Export usage data as JSON
 */
export function exportUsageData() {
  const data = loadUsageData();
  return JSON.stringify(data, null, 2);
}

/**
 * Clear all usage data
 */
export function clearUsageData() {
  const emptyData = { 
    ...DEFAULT_STORAGE, 
    summary: { 
      ...DEFAULT_STORAGE.summary,
      byModel: {},
      byFeature: {}
    } 
  };
  saveUsageData(emptyData);
  console.log('[TokenTracking] Usage data cleared');
  return true;
}

/**
 * Format token count for display
 */
export function formatTokenCount(count) {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(2)}M`;
  } else if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return count.toString();
}

/**
 * Format cost for display
 */
export function formatCost(cost) {
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  } else if (cost < 1) {
    return `$${cost.toFixed(3)}`;
  }
  return `$${cost.toFixed(2)}`;
}

/**
 * Get pricing table for reference
 */
export function getPricingTable() {
  return PRICING;
}
