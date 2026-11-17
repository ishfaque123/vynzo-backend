// Boost — plans, purposes and manual payment details.
//
// SINGLE SOURCE OF TRUTH for boost pricing, estimated results and the
// payment details shown in the Boost flow. Clients never hardcode these
// values: they read them from GET /api/boosts/config, which returns this
// config. Amounts are also re-derived from the chosen plan server-side
// when a boost request is created — the client's amount is never trusted.
//
// Payment details are FINAL (owner-supplied 2026-11-18): EasyPaisa Till
// 990001988 / SHAHI COMMUNICATION, JazzCash business 984580283 /
// ISHFAQ Shop.

export const BOOST_COUNTRY_CODE = 'PK';

export type BoostContentType = 'post' | 'reel';

export const BOOST_CONTENT_TYPES: BoostContentType[] = ['post', 'reel'];

// Why the user is boosting. Required on every boost request and stored
// on the row so the admin queue (and later reporting) can see the goal.
export type BoostPurpose = 'followers_gain' | 'views_gain' | 'business_promotion';

export interface BoostPurposeOption {
  id: BoostPurpose;
  label: string;
  description: string;
}

export const BOOST_PURPOSES: BoostPurposeOption[] = [
  { id: 'followers_gain', label: 'Followers Gain', description: 'Grow your profile followers.' },
  { id: 'views_gain', label: 'Views Gain', description: 'Get more views on this post or reel.' },
  { id: 'business_promotion', label: 'Business Promotion', description: 'Promote a product, service or business.' },
];

export interface BoostPlan {
  days: number;
  amountPkr: number;
  // ANDAZAN (estimated) results for the plan — shown to the user as
  // estimates, never as a guarantee.
  estViewsMin: number;
  estViewsMax: number;
  estClicksMin: number;
  estClicksMax: number;
}

export const BOOST_PLANS: BoostPlan[] = [
  { days: 1, amountPkr: 100, estViewsMin: 500, estViewsMax: 1000, estClicksMin: 30, estClicksMax: 60 },
  { days: 3, amountPkr: 250, estViewsMin: 1500, estViewsMax: 3000, estClicksMin: 90, estClicksMax: 180 },
  { days: 7, amountPkr: 500, estViewsMin: 4000, estViewsMax: 7000, estClicksMin: 250, estClicksMax: 450 },
];

// First-boost trial (owner decision 2026-11-18): a user who has NEVER
// had an approved boost before pays Rs 79 for the 1-day plan instead of
// Rs 100. All other prices are unchanged. Like every amount, the trial
// price is applied server-side only (boostService derives it); the
// config payload tells the client when the trial price applies so it
// can show it on the 1-day plan card.
export const BOOST_FIRST_BOOST_TRIAL = { planDays: 1, amountPkr: 79 };

// Active-boost limit (owner suggestion, approved 2026-11-18): a user
// may have at most this many boosts live at the same time — approved
// and still inside their window (expiry computed on read, like
// everywhere else in the boost feature). Pending requests do NOT count
// toward the limit. Enforced server-side in
// boostService.createBoostRequest (409 BOOST_LIMIT_REACHED).
export const BOOST_MAX_ACTIVE_BOOSTS = 3;

export interface BoostPaymentMethod {
  id: 'easypaisa' | 'jazzcash';
  label: string;
  accountTitle: string;
  accountNumber: string;
  instructions: string;
}

export const BOOST_PAYMENT_DETAILS: { methods: BoostPaymentMethod[] } = {
  methods: [
    {
      id: 'easypaisa',
      label: 'EasyPaisa',
      accountTitle: 'SHAHI COMMUNICATION',
      accountNumber: '990001988',
      instructions: 'Send the amount to this EasyPaisa Till ID, then upload the payment screenshot below.',
    },
    {
      id: 'jazzcash',
      label: 'JazzCash',
      accountTitle: 'ISHFAQ Shop',
      accountNumber: '984580283',
      instructions: 'Send the amount to this JazzCash business number, then upload the payment screenshot below.',
    },
  ],
};
