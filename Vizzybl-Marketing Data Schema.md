Every other root-level collection we've designed (`campaigns`, `signups`) uses the `tenantId` from this schema as a strict foreign key partition. This layout ensures that our public landing page router can map incoming domain traffic to the correct tenant context, validate origin security, and manage team access boundaries without utilizing global admin privileges.

# 1\. Core Tenant Schema

This lives in your root-level `tenants` collection. It manages global metadata, whitelabel routing domains, and operational states for each distinct brand.

Collection: `tenants`  
JSON

```
{
  "id": "ten_vzb123",                      // The unique tenant ID used to partition all downstream data
  "tenantName": "Vizzybl AI",              // Human-readable brand name for the dashboard
  "rootDomain": "vizzybl.ai",              // Master domain associated with this SaaS workspace
  "status": "active",                      // Enum: 'active' | 'suspended' | 'trial'
  
  // Security & Ingestion Gatekeeping
  "allowedOrigins": [
    "https://vizzybl.ai",
    "https://waitlist.vizzybl.ai",
    "https://localhost:3000"                // Allows safe local MVP testing
  ],
  
  // Operational Global Settings
  "billingTier": "mvp_free",               // Useful for scaling limitations down the road
  "ownerId": "usr_owner7788",              // Firebase Auth UID of the primary tenant creator
  
  "createdAt": "2026-06-15T16:05:00Z",
  "updatedAt": "2026-06-15T16:05:00Z"
}
```

2\. Dashboard Access Schema (Tenant Collaborators)

To support logging into your portal, selecting a brand from your sidebar dropdown menu, and ensuring a user only sees the brands they own, we implement a `tenant_users` association collection.

By keeping this flat rather than using subcollections, your portal can query all accessible brands for a logged-in user in a single, lightning-fast database read.

Collection: `tenant_users`  
JSON

```
{
  "id": "tu_join_9911",
  "userId": "usr_owner7788",               // Maps directly to the logged-in user's Auth UID
  "tenantId": "ten_vzb123",                // Grants access to this specific tenant
  "role": "admin",                         // Enum: 'admin' | 'member'
  "joinedAt": "2026-06-15T16:05:00Z"
}
```

# 1\. Unified Campaign Configuration Schema

This lives in your **`campaigns`** collection. It gives you full control over branding, questionnaire builders, widget rules, and social microcopy on a per-campaign basis.

Collection: `campaigns`  
JSON

```
{
  "id": "camp_vzb_beta_01",
  "tenantId": "ten_vzb123",               // The multi-tenant organization anchor
  "waitlistName": "Awesome Wait Launch",  // Prominent widget/email name
  "waitlistUrlLocation": "https://vizzybl.ai/beta", // Configured deployment home
  
  // Rules & Logic Gates
  "spotsToMoveUponReferral": 3,           // Base skip weight
  "usesFirstnameLastname": false,         // Forces first/last name collection
  "usesLeaderboard": true,                // Enables public leaderboard array
  "usesSignupVerification": false,        // Toggles email validation requirement
  "hideCounts": false,                    // Suppresses positions/counts in UI
  "removeWidgetHeaders": false,           // Strips labels over input fields
  "requiredContactDetail": "EMAIL",       // EMAIL, PHONE, BOTH, or EITHER
  
  // Custom Form Builder (Answers spec)
  "questions": [
    {
      "question_value": "What is your favorite animal?",
      "optional": false,
      "answer_value": ["Cat", "Dog", "Duck", "Other"] // Options or null for text
    }
  ],
  
  // Marketing & Notifications
  "twitterMessage": "Check out this waitlist!", // Tailored sharing copy
  "sendEmailCongratulationsOnReferral": true,    // Triggers internal worker on milestone
  "leaderboardLength": 5,                 // Rows returned to front-end (default: 5)
  
  // Layout Styling Configuration (UI Customization)
  "configurationStyleJson": {
    "widgetBackgroundColor": "#4937E7",
    "widgetButtonColor": "#000000",
    "widgetFontColor": "#000000",
    "statusDescription": "Thanks for signing up!",
    "socialLinks": {
      "linkedin": "https://linkedin.com/company/vizzybl",
      "twitter": "https://twitter.com/vizzybl"
    }
  },
  
  "createdAt": "2026-06-15T16:00:00Z"
}
```

# 2\. Comprehensive Signup Document Schema

This lives in your **`signups`** collection. It fuses your fraud tracking, personal details, system scoring, and open-ended developer payloads (`metadata`) into one cost-effective serverless document.

Collection: `signups`  
JSON

```
{
  "id": "c60ff9f2-1a58-4551-87ea-414991184fba", // The unique UUID anchor
  "tenantId": "ten_vzb123",
  "campaignId": "camp_vzb_beta_01",
  
  // Core Identity 
  "firstName": "Maya",
  "lastName": "Kyler",
  "email": "maya@getwaitlist.com",
  "phone": null,
  
  // Structural Security & State
  "verified": false,                       // True if email verification link clicked
  "captchaValid": false,                   // Updated dynamically without blocking signups
  "isSpam": false,                         // Gated automatically via domain blocklists
  "status": "verified_active",             // verified_active, unverified, offboarded, deleted
  
  // Dynamic Referral Mechanics
  "amountReferred": 0,                     // Total count of verified invitations driven
  "referralToken": "4F0BTBMAB",           // Unique affiliate token code
  "referralLink": "https://getwaitlist.com?ref_id=4F0BTBMAB",
  "referredBySignupToken": "REFTOKEN1",    // Parent token that gets the credit link
  
  // Queue Management Mathematics
  "score": 1498421890,                     // Calculated points variable for sorting
  
  // Historical Offboarding Parameters
  "removedDate": null,                     // ISO timestamp populated at offboarding
  "removedPriority": null,                 // Captured static queue position at offboarding
  
  // Arbitrary Developer Payload & Form Answers
  "metadata": {
    "experiment_cohort": "variant_b",
    "stripe_customer_id": "cus_H1234"      // Supports passing anything your app needs
  },
  "answers": [
    {
      "question_value": "What is your favorite animal?",
      "optional": false,
      "answer_value": "Cat"
    }
  ],
  
  "createdAt": "2026-06-15T16:01:00Z"
}
```

