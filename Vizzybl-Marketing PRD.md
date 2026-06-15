## **1\. UI & Sidebar Architecture (The Portal Layout)**

The MVP portal handles multiple brands seamlessly by placing a global **Brand Selector** at the top of a persistent but collapsable sidebar navigation menu.

**Multi-Tenant SaaS architecture**  managing isolated standalone brands to enforcing strict tenant boundaries using a standardized `tenantId`.

In this multi-tenant paradigm, every request, database row, agent invocation, and analytical data point is strictly scoped to a specific tenant context. This ensures that whether you are running `vizzybl.ai` or onboarding a completely new brand tomorrow, the application treats them as completely isolated SaaS customers.

```
┌──────────────────────────────────────────────┐
│ [ Brand Selector: vizzybl.ai  ▼ ]            │
├──────────────────────────────────────────────┤
│ 📁 Sales (Placeholder - Disabled/Coming Soon) │
│                                              │
│ 📢 Marketing                                 │
│    ├── 🚀 Campaigns
|	|----- Waitlists                            │
│   
└──────────────────────────────────────────────┘
```

*   
  **Sales Entry:** Renders a clean placeholder page explaining the feature road map, preventing scope creep.  
* **Marketing Entry:** Campaigns page is coming soon. Waitlist is our first feature to ship and the focus on this document. The Campaign dashboard workspace where you configure campaign details.

## **3\. Network Architecture: The Private Tenant Perimeter**

Because this is a secure system by design, public internet access is completely blocked for all your agents and processing workers. Tenancy information is extracted at the public perimeter and securely passed down the internal stack.

```
[Public Web Traffic] ──> [Cloud HTTP(S) Load Balancer + Cloud Armor + reCAPTCHA Enterprise]
                                                   │
                            (Resolves custom domain to tenantId)
                                                   │
                                                   ▼
                                [Public Cloud Run: Landing Page Router]
                                                   │
                                     (Serverless VPC Access Connector)
                                                   │
                                                   ▼
                🛡️ [Internal VPC Perimeter (VPC Service Controls)] 🛡️
                                                   │
          ┌────────────────────────────────────────┴────────────────────────────────────────┐
          ▼                                        ▼                                        ▼
[Internal Cloud Run:          [Internal Cloud Run: ADK 2.0]            [Firestore Instance]
 Waitlist Processors]         (Agent contexts isolated by tenantId)   (Rules enforce matching tenantId)
```

1.   
   **The Ingress Gateway:** The public Cloud Run edge router matches the request's host header (e.g., `waitlist.vizzybl.ai`) to its internal tenant config cache, resolving the request to `tenantId: ten_vzb123`.  
2. **Anti-Bot & Shielding Gate:** The landing page router verifies the reCAPTCHA token. If the tenant configuration has `restrictToBusinessEmails` enabled, the router executes a regex check against disposable domain patterns and standard free webmails (like Gmail or Yahoo) right at the edge.  
3. **Private Downstream Handshake:** The edge router forwards the signup data along with the explicit `tenantId` payload through a Serverless VPC Access connector to your internal, non-internet-facing processing pool.

## **5\. Isolated Multi-Tenant Analytics Pipeline (BigQuery)**

To meet your requirement that analytical actions never stress production transactional performance, raw data is streamed away from Firestore instantly.

### **The Streaming Pipeline**

The **Firestore-to-BigQuery Extension** securely forwards document updates directly into a centralized BigQuery landing area. To guarantee absolute multi-tenant data privacy at the analytical layer, we employ **BigQuery Row-Level Security (RLS)** or **Authorized Views** split by `tenantId`.

SQL

```
-- An example analytical view pattern enforced within BigQuery
CREATE OR REPLACE VIEW `my_project.marketing_analytics.v_tenant_leaderboard` AS
SELECT 
  tenant_id,
  campaign_id,
  email,
  points,
  RANK() OVER (PARTITION BY tenant_id, campaign_id ORDER BY points DESC) as tenant_rank
FROM 
  `my_project.firestore_export.waitlist_signups_raw`
WHERE 
  -- Enforces operational tenancy boundary dynamically
  tenant_id = @run_time_tenant_context;
```

## **1\. The Low-Cost Solution: Score-Based Ranking in Firestore**

Since we are ditching Redis, we can keep the exact same score formula and store it directly inside **Cloud Firestore (Native Mode)**.

$$\\text{Score} \= (\\text{Referrals} \\times 500\) \- \\text{Unix\\\_Timestamp\\\_Of\\\_Signup}$$  
Because Firestore allows you to index and sort fields natively, we never have to update other users' positions when someone gets a referral. We only update the single referrer's document.

### **How to Calculate "Queue Position" Cheaply**

To show a user their live position on the waitlist, instead of maintaining a rigid sequential list, you run a Firestore **Aggregation Count Query**.

TypeScript

```
// How to find a user's rank inside a specific tenant's campaign
const rankQuery = db.collection('signups')
  .where('tenantId', '==', 'ten_vzb123')
  .where('campaignId', '==', 'beta-launch')
  .where('isVerified', '==', true)
  .where('score', '>', userScore); // Count how many people have a higher score

const snapshot = await rankQuery.count().get();
const currentPosition = snapshot.data().count + 1;
```

💰 **Why this is incredibly cheap:** Firestore charges 1 document read for every **1,000 documents** counted in an aggregation. If a tenant has 3,000 people on their waitlist, calculating a user's rank costs just 3 document reads (a fraction of a penny).

## **2\. Serverless Pay-As-You-Go Architecture**

By swapping out the heavy infrastructure, your secure network topology becomes lightweight and cost-effective:

```
[Public Web Traffic] ──> [Cloud Run: Public Edge Router] ($0 if idle)
                                       │
                        (Internal VPC / Serverless Connector)
                                       │
                                       ▼
    ┌──────────────────────────────────┴──────────────────────────────────┐
    ▼                                  ▼                                  ▼
[Firestore (Native)]        [Cloud Run: ADK 2.0 Agents]         [BigQuery Data Lake]
 - Pay-per-read/write        - Scales to zero when idle          - 10GB free storage
 - Zero base cost            - Scoped Service Accounts           - Sandbox / Free tier queries
```

*   
  **Public Edge Router (Cloud Run):** Handles the landing pages, checks reCAPTCHA, and drops to zero instances when traffic disappears.  
* **Firestore:** Replaces AlloyDB and Redis. You get 50,000 free reads and 20,000 free writes per day.  
* **BigQuery:** The **Firestore-to-BigQuery Extension** handles streaming automatically. BigQuery gives you 1 TB of query processing free every month, which is more than enough for optimization analytics at this scale.

## **4\. Modified Least-Privilege IAM & ADK 2.0 Framework**

Since we are explicitly avoiding the Firestore Admin SDK (`firebase-admin`), your microservices and ADK 2.0 agents authenticate using specific Google Service Accounts.

Instead of an all-powerful master key, use Gemini Enterprise Agent Platform Agent Identity for each agent.

## **GCP & Agent Architecture Mapping**

To realize your workflow utilizing **Google's Agentic Data Cloud**, ground your 6 agents using the following architectural patterns: FOR NOW THIS IS FOR AWARENESS. ONLY AGENTS SPECIFIED IN THE PRD ARE IN SCOPE but ensure we are designing for a multi-agent system. 

```
[Scrapers / APIs] ──> [Cloud Storage / AlloyDB] ──> [BigQuery Lakehouse]
                                                             │
[Gemini Enterprise Platform] <── [Agent Development Kit] <───┘
```

### **1\. Strategy Layer**

* **Agent 1 (Market Intelligence):** Use **BigQuery Object Tables** linked to a Cloud Storage bucket where Firecrawl deposits raw text files. The agent utilizes **Gemini 1.5 Pro** via BigQuery AI functions to perform semantic analyses on unstructured files without data movement.  
* **Agent 2 (Strategy & Budget Planner):** Implements a **Memory Bank** architecture. It maps current competitor patterns against historical budget execution trends stored in BigQuery via hybrid search.

### **2\. Creative & Distribution Layers**

* **Agent 3 (Creative Director & Copywriter):** Orchestrated via **Agent Studio**. It pulls performance feedback metrics from prior campaigns and drafts copy options. For visuals, it can utilize Vertex AI Image Generation models or pass prompts out to your preferred Midjourney API through Cloud Functions.  
* **Agent 4 (Campaign Operations Agent):** Built with the Google Cloud **Agent Development Kit (ADK)** using external tool connections via the **Model Context Protocol (MCP)**. This allows the agent to safely authenticate with Meta/Google Ads APIs, upload the creative components, and return the tracking parameters.

### **3\. Guardrails, Measurement, & Optimization**

* **Logistics & QA Gate:** Implement **Model Armor** to scan the output of Agent 3 for brand safety violations or prompt injections before hitting the human gate. The Slack integration is run via an asynchronous event on Cloud Run that pauses the execution state inside the ADK.  
* **Agent 5 (Performance Analytics):** Built using **BigQuery Continuous Queries**. Instead of running batch updates every hour, this agent processes events from GA4 stream inputs instantly to analyze high-performing variants.  
* **Agent 6 (Optimization Governor):** Acts as the supervisor agent. When it detects low performance on a landing page via Agent 5, it triggers a child agent call using the **Agent-to-Agent (A2A) protocol**, signaling Agent 3 to iterate on a specific ad variant

Here is the detailed Product Requirements Document (PRD) for the first feature: the **Signups Page**.  
The product philosophy here is to keep the transactional app layer incredibly lean. The backend focuses strictly on lightweight user mutations, while the data pipeline streams everything to BigQuery in real time to handle the heavy analytical heavy lifting.  
Here is the trimmed, hyper-focused   
**Product Requirements Document (PRD)**

## **Feature: Waitlist Signups Management & BigQuery Analytics Pipeline**

**Status:** Refined MVP | **Target Audience:** Workspace Owners & Data Engineers

### **1\. Objective**

To provide a fast, responsive administrative dashboard for managing waitlist user lifecycles (viewing active lists, manually moving positions, and offboarding users). To keep the core operational database ultra-lean and performant, all transactional write events and user mutations stream natively to a BigQuery data lake in real time to power downstream analytics.

### **2\. Scope**

The feature is constrained strictly to operational management and data streaming:

1. **All Signups Dashboard:** A real-time data table supporting row actions, manual sorting adjustments, and lifecycle mutations.  
2. **Offboarded Signups Directory:** An isolated view tracking users who have successfully matriculated off the waitlist.  
3. **Real-Time BigQuery Streaming Pipeline:** The underlying serverless data pipeline that mirrors operational Firestore mutations straight into BigQuery for analytics.

### **3\. User Stories**

* **As an Admin**, I want to see a comprehensive, scannable list of all active signups so I can monitor my waitlist size at a glance.  
* **As an Admin**, I want to execute bulk actions (Move Up, Offboard, Delete) on multiple rows simultaneously to save time.  
* **As an Admin**, I want to manually improve a specific user's queue position to handle VIP priority adjustments.  
* **As an Admin**, I want all signup events, custom question responses, and marketing UTM data to flow instantly into a data lake so that my analytics dashboard always displays real-time performance metrics.

### **4\. Functional Requirements**

#### **4.1 "All Signups" Dashboard Table**

* **Data Display:** Provide an optimized, paginated data grid rendering critical user properties: Email, Name, Rank, Referrals, and Status.  
* **Dynamic Selection:** Include universal and row-level checkboxes to handle single or multi-select arrays.  
* **Contextual Actions Menu:** An actionable toolbar must slide into view when rows are active, exposing:  
  * **Move Position:** Improves queue priority (e.g., moves a user up from spot **\#500** to **\#100**). *Note: The system restricts moving positions downward.*  
  * **Offboard:** Transitions users from "Waiting" to "Offboarded", removing them from the active list and triggering the automated offboarding email pipeline.  
  * **Delete:** Permanently purges records from the operational database (e.g., handling test accounts or spam).

#### **4.2 "Offboarded Signups" Directory**

* **Isolation Grid:** A dedicated directory tab displaying only successfully offboarded users to keep active lists clean.  
* **Permitted Actions:** Restricted exclusively to multi-select and **Delete** actions.

#### **4.3 Real-Time BigQuery Streaming Pipeline**

The operational database (Firestore) acts purely as a transactional state-machine. It does not run complex aggregation queries. Instead, all structural mutations stream instantly into BigQuery.

```

[User Action / Admin Mutation]
              │
              ▼
    [Firestore Database] ──(Native Real-Time Stream)──► [BigQuery Data Lake]
              │                                                 │
   (Operational State)                                 (Downstream Analytics)

```

* **Trigger Events:** The streaming pipeline must intercept and mirror the following events to BigQuery within seconds of occurrence:  
  * **Creation:** New signup joins the waitlist (capturing Email, Timestamp, Initial Rank).  
  * **Enrichment:** Custom survey questions answered (Q\&A data payload) or marketing tracking captured (all **5 standard UTM parameters**).  
  * **State Mutation:** User is moved up in line, verified via email, or transitioned to Offboarded.  
  * **Deletion:** User is purged from the system (the data lake flags or archives the row accordingly for historical analytics accuracy).  
* **Schema Depth:** The streamed BigQuery rows must accurately capture the entire user footprint: Identity, Referrer IDs, complete custom metadata fields, CAPTCHA pass metrics, and tracking parameters.

### **5\. Non-Functional Requirements**

* **Streaming Latency:** Mutations in the operational database must propagate and land in the BigQuery analytical dataset with minimal delay (targeting a near-real-time streaming SLA of under **5 seconds**).  
* **Zero Application Overhead:** The streaming process must execute completely asynchronously at the infrastructure level via serverless triggers, ensuring core API response times for signing up new users remain completely unaffected.

# **Product Requirements Document (PRD)**

## **Feature: Agentic Email Hub (With Human-in-the-Loop Overrides)**

**Status: Refined MVP | Parent Platform: vizzybl.ai Ecosystem | Target Audience: Workspace Owners & Marketers**

### **1\. Objective**

**To streamline email marketing and automated lifecycle communications by substituting legacy drag-and-drop builders with an Agentic Creative Hub. Powered by Agent 3 (Creative Director & Copywriter), the platform autonomously handles audience context matching, asset generation, and brand alignment while preserving foundational administrative controls, precise segment targeting, and manual copy-editing capabilities.**

### **2\. Scope**

1. **Global Configuration & Routing: Managing base communication rules (Reply-To, dynamic variable token mappings).**  
2. **The Agentic Briefing Matrix: A minimalist markdown interface for defining campaign objectives or tone shifts.**  
3. **Human-in-the-Loop (HITL) Editor: An inline editing pane for the admin to tweak, rewrite, or manually finalize Agent-generated drafts.**  
4. **Targeted Lifecycle & Blast Execution: Automated triggers for lifecycle milestones (e.g., Offboarding) and manual segment-targeted broadcast dispatches.**

### **3\. User Stories**

* **As an Admin, I want to set a global "Reply-To" email address so that when users reply to automated waitlist emails, their responses go straight to my support inbox.**  
* **As an Admin, I want to configure an "Offboarding" email so users are automatically notified with next steps or product access links when they are let off the waitlist.**  
* **As an Admin, I want to use dynamic variables (like Waitlist Position, Referral Link, or custom metadata like Job Title) inside the email body to personalize the messaging for every user.**  
* **As an Admin, I want to send an "Email Blast" to my entire waitlist (or a specific segment) to announce an upcoming launch and build hype without leaving the platform.**  
* **As an Admin, I want to review and manually edit the copy generated by Agent 3 before it goes live, ensuring I maintain absolute creative control.**  
* **As an Admin, I want Agent 3 to pull insights from my BigQuery data lake so that its generated drafts automatically leverage messaging frameworks that are converting best for my specific audience.**

### **4\. Functional Requirements**

#### **4.1 Global Infrastructure Settings**

* **Reply-To Routing: A dedicated field in settings allowing admins to declare a custom inbound routing address. All automated transactional rows and blast headers must map their** Reply-To **properties to this anchor.**  
* **Dynamic Token Ingestion Engine: The email parser must support and resolve standardized merge tokens inline, rendering unique data points per user dynamically at dispatch:**  
  * {waitlist\_position}  
  * {referral\_link}  
  * {metadata.field\_name} **(e.g.,** {metadata.job\_title}**,** {metadata.company}**)**

#### **4.2 Agent 3 Generation Core**

* **Context Retrieval: Upon user activation of a generation prompt, Agent 3 queries the tenant's BigQuery data lake to determine which historical phrasing, imagery styles, and tone parameters yielded optimal open/conversion trends.**  
* **Multimodal Synthesis: Agent 3 coordinates with Gemini (for structural copy variations) and Vertex AI models (for dynamic inline visuals/graphic dividers) to build a cohesive email draft layout.**

#### **4.3 Human-in-the-Loop (HITL) Interface & Editing Block**

* **The Draft Preview State: Generated copy options are presented to the administrator within a clean text/markdown editing pane rather than being committed straight to a live pipeline.**  
* **Manual Overrides: The admin can click directly into any text or markdown block generated by Agent 3 to append notes, rewrite sentences, add links, or manually insert dynamic token strings (**{referral\_link}**).**  
* **Veto & Regenerate: The admin can provide directional feedback (e.g., *"Make the second paragraph shorter and punchier"*) to command Agent 3 to draft an alternate version, or manually override the layout entirely.**

```

[Admin Intent Prompt] 
       │
       ▼
[Agent 3 Generates Draft via Gemini/Vertex AI] 
       │
       ▼
[HITL Interactive Editor] ◄─── Admin manually edits text/variables inline
       │
       ▼
[LLM-as-a-Judge Validation Guardrails]
       │
       ▼
[Approved for Execution Queue]

```

#### **4.4 Lifecycle & Segmented Blast Distribution Engines**

* **Lifecycle Rules: The backend maps specific automated email triggers based on user state changes. Specifically, transitioning a user to "Offboarded" status within the system must autonomously fetch the verified Offboarding template, parse the target's unique metadata, and dispatch the email.**  
* **Segmented Email Blasts:**  
  * **Targeting Controls: Provide a segmentation interface allowing the admin to filter recipients (e.g., *All Active Users*, *Users with \>3 Referrals*, or *Custom Metadata Tags*).**  
  * **Execution: Once the audience segment is isolated and the Agent 3 generation has been manually edited and approved by the admin, the payload enters an asynchronous broadcast queue to handle high-volume distribution smoothly.**

#### **4.5 LLM-as-a-Judge Guardrail Service**

* **Syntax & Variable Validation: Evaluates the final code/text configuration right before delivery. It validates that dynamic tokens (especially those manually typed or edited by the admin) conform to exact formatting rules (**{variable}**) to protect against broken syntax string errors reaching a user's inbox.**

### **5\. Architectural Non-Functional Requirements**

* **State Decoupling: Keep Agent 3's core design decoupled from the waitlist tracking mechanics, allowing its workspace components to scale natively into future marketing modules within the** vizzybl sales and marketingi **application.**  
* **Inline Editor Frictionless State: The transition between the Agent generating text and the admin clicking inside to type must be instant ($\<10\\text{ms}$ input delay), treating the generative output as editable plain-text/markdown text frames.**

# **Product Requirements Document (PRD)**

## **Feature: Viral Waitlist Leaderboard (Backend & API Engine)**

**Status: Draft | Target Audience: Backend Engineers / API Integrators / Workspace Owners**

### **1\. Objective**

**To drive product virality and organic user acquisition through a gamified, competitive referral leaderboard. The backend engine must calculate rankings based on successful referrals and safely expose this dataset via a fast, unauthenticated public API endpoint and no-code embed widgets without exposing sensitive user information.**

### **2\. Scope**

**The Leaderboard feature encompasses three distinct implementation layers:**

1. **Administrative Controls: Configuration toggles on the waitlist dashboard (Enabling/Disabling & sizing).**  
2. **Ranking & Data Processing Engine: Real-time array sorting and data anonymization rules.**  
3. **Public API Endpoint: An unauthenticated** GET **route serving the leaderboard payload to external frontends.**

### **3\. User Stories**

* **As an Admin, I want to toggle the leaderboard feature on or off via the dashboard so that I can decide when to introduce competitive mechanics to my pre-launch campaign.**  
* **As an Admin, I want to set a default leaderboard length (e.g., top 5 or top 10 users) from my dashboard to control how much data is fetched by default.**  
* **As a Developer, I want to query an unauthenticated API endpoint to fetch real-time leaderboard data so I can easily build a completely custom landing page interface.**  
* **As an End User, I want to see a public leaderboard displaying top referrers so that I am motivated to share my referral link and climb into the top tier.**  
* **As an End User, I want my personal data (email, phone number, last name) to be heavily masked on public leaderboards to protect my privacy from third-party scraping.**

### **4\. Functional Requirements**

#### **4.1 Dashboard Configuration & Entitlements**

* **Feature Toggle: Administrators must be able to navigate to** Dashboard \-\> Features**, check a Leaderboard checkbox, and save to alter the waitlist behavior state.**  
* **Plan Gating: Access to the leaderboard functionality is a premium asset and must be strictly restricted to the Pro Plan (or higher tiers).**  
* **Length Parameter: Provide a configuration field under the leaderboard checkbox allowing admins to define the default length of the array returned (Default setting:** 5**).**

#### **4.2 Ranking & Computation Engine**

* **Sorting Logic: The backend must compile active waitlist signups and sort them dynamically. The signup with the highest number of successful referrals must occupy the index** 0 **position.**  
* **Data Privacy Protection (Mandatory Data Masking): Because the leaderboard API is unauthenticated and exposed publicly, the rendering engine must programmatically censor user records before returning the data payload.**

| Data Field | Censorship Rule | Example Input | Example Output |
| :---- | :---- | :---- | :---- |
| amount\_referred | **Exposed completely as an integer/string** | 5 | 5 |
| first\_name | **Exposed fully** | Brittany | Brittany |
| last\_name | **Truncate to first letter \+ a trailing period** | Sawyer | S. |
| email | **Mask characters between first letter and** @**, and mask domain** | bani@getwaitlist.com | b\*\*\*@g\*\*\*\*\*\*\*\*\*\*\*\*\*\* |
| phone | **Display first 3 digits only, replace the rest with asterisks** | 1234567891 | 123 \*\*\* \*\*\*\* |

### **5\. Edge Cases & Exception Handling**

* **Empty Leaderboard Response: If the feature is enabled but no users have successfully made a referral yet, the backend must return an empty JSON array (**"leaderboard": \[\]**) rather than throwing an exception or rendering unreferred signups.**  
* **Invalid Waitlist ID: Requests targeting a non-existent or malformed** \<WAITLIST\_ID\> **must yield a standard validation error response explaining that the resource was not found.**  
* **Leaderboard Length \= 0: If an administrator explicitly misconfigures or explicitly overrides the leaderboard length to** 0**, the API must return an empty list gracefully.**

### **6\. Non-Functional Requirements**

* **Cache Strategy: To avoid intensive database queries on high-traffic launch days, leaderboard data should employ  using Firestore's low-cost native aggregation count queries (`db.collection().count().get()`), which charge a fraction of a cent per 1,000 documents evaluated. For public hit tracking counters (e.g., *"Join 8,421 marketers"*), use an edge-cached Cloud CDN configuration duration of 1 to 5 minutes on the public landing zone router. This delivers the exact same performance budget (\<150ms) with $0 baseline infrastructure overhead.**  
* **Reliability: API responses must execute within minimal latency budgets ($\<150\\text{ms}$) to keep embedded no-code widgets and consumer-facing landing pages loading instantly.**

**Here is the detailed Product Requirements Document (PRD) for the Questions & Answers (Q\&A) feature.**

# **Product Requirements Document (PRD)**

## **Feature: Waitlist Questions & Answers (Survey Responses)**

**Status: Draft | Target Audience: Waitlist Administrators / Developers / End Users**

### **1\. Objective**

**To allow waitlist administrators to seamlessly embed custom survey questions directly into their waitlist signup flow. This feature enables teams to gather valuable qualitative and demographic data (e.g., use cases, job titles, product feedback) at the exact moment a user exhibits high intent by joining the waitlist.**

### **2\. Scope**

**The Q\&A feature encompasses the following areas:**

1. **Dashboard Configuration: UI for admins to create and manage custom questions within the Widget Builder.**  
2. **Widget Rendering (No-Code): Automatic injection of configured questions into the standard waitlist UI widgets.**  
3. **API Support: Backend logic to accept question responses payload securely via API for custom implementations.**  
4. **Data Handling: Storing responses and associating them directly with the individual user's signup record.**

### **3\. User Stories**

* **As an Admin, I want to ask users custom questions during sign-up so I can understand my audience better and qualify leads.**  
* **As an Admin, I want to offer an open-ended text box so users can type free-form answers (e.g., "What is your biggest pain point?").**  
* **As an Admin, I want to provide a specific list of dropdown options (e.g., "How did you hear about us? \- Twitter, Google, Friend") to standardize data collection.**  
* **As a non-technical Admin, I want the questions I configure to automatically appear on my embedded waitlist widget without needing to write any new code.**  
* **As a Developer, I want to submit users' answers as part of the JSON payload to the Signup API so my completely custom frontend can still utilize the backend Q\&A storage.**  
* **As an Admin, I expect this Q\&A data to be fully exportable along with my signups data (as specified in the Signups Management PRD).**

### **4\. Functional Requirements**

#### **4.1 Dashboard Configuration (Widget Builder)**

* **Location: Configuration must live inside the Dashboard \-\> "Widget Builder" \-\> "Questions" tab.**  
* **Question Creation: Admins can add multiple custom questions to their waitlist form.**  
* **Input Types:**  
  * **Free Text Input: If the admin leaves the answer configuration field empty, the system must render a standard text input field for the end user.**  
  * **Dropdown Selection: If the admin inputs a comma-separated list (e.g.,** Option A, Option B, Option C**), the system must parse these values and render a select/dropdown menu on the frontend widget.**  
* **Syncing Constraints: The questions configured in the dashboard act as the "source of truth". Any changes made here must immediately reflect on the hosted no-code widgets.**

#### **4.2 No-Code Widget Integration**

* **Dynamic Rendering: The pre-built no-code widget (HTML/Iframe/React components) must automatically fetch the configured questions and inject them into the signup form directly above the "Submit/Join" button.**  
* **Validation: The frontend should require valid inputs (or handle optional vs. mandatory toggles if configured) before allowing the signup to process.**

#### **4.3 API Integration**

* **Payload Structure: Developers using the raw API must be able to pass an** answers **object containing the user's responses when calling the Create Signup endpoint.**  
* **Strict Matching: The backend must validate the incoming API** answers **object against the questions configured in the dashboard. If a developer attempts to submit answers to a question that doesn't exist in the dashboard (or sends a dropdown answer that isn't in the comma-separated list), it must be handled appropriately (e.g., rejected or sanitized).**

#### **4.4 Data Visibility**

* **Responses to these questions must be attached to the specific user's signup record.**  
* **This data must be viewable in the "Signups" dashboard tab and included in all CSV exports.**

### **5\. Non-Functional Requirements & Plan Constraints**

* **Gating: This functionality is explicitly marked as a Premium Feature. Administrators must be on a Pro Plan (or higher) to unlock the "Questions" tab in the Widget Builder and utilize the Q\&A API payloads. Free tier users attempting to configure Q\&A should hit a paywall.**  
* **Performance: Adding questions to a widget must not introduce noticeable latency to the widget loading speed.**  
* **Data Privacy: Custom responses may contain PII (Personally Identifiable Information) entered by users; the database must encrypt and store this alongside standard signup data safely.**

# **Product Requirements Document (PRD)**

## **Feature: Standalone Hosted Landing Page**

**Status: Draft | Target Audience: Waitlist Administrators / No-Code Creators**

### **1\. Objective**

**To provide every waitlist creator with an instantly accessible, standalone, zero-code hosted landing page. This feature eliminates the immediate dependency on an external website builder, allowing users to spin up a launch campaign instantly, embed the form securely via iframes, and maintain an automatic fallback page for viral referrals or website downtime.**

### **2\. Scope**

**The Hosted Page feature encompasses the following functional areas:**

1. **The Standalone Layout: Rendering a clean page layout housing the Full Waitlist Widget and the brand logo.**  
2. **Style Synchronization: Inheriting styles directly from the Widget Builder config.**  
3. **Automated Referral Routing Logic: Acting as the default routing target for viral loops when a custom website URL is not specified.**  
4. **Dashboard Access: The UI anchor within the builder environment to instantly open or copy the page link.**

### **3\. User Stories**

* **As an Admin, I want a functional landing page hosted out-of-the-box so that I can collect signups instantly without configuring a website domain first.**  
* **As a Wix or closed-ecosystem Creator, I want a clean hosted page URL so that I can embed my waitlist into my platform using standard iframes.**  
* **As an Admin, I want my viral referral links to seamlessly point to my hosted page if I leave my main product website setting blank, protecting my viral growth loops from failing.**  
* **As an Admin, I want changes to my widget's typography, colors, or custom fields to apply to my hosted page instantly, avoiding duplicate design management work.**  
* **As an Admin, I want a robust architectural fallback so that if my main marketing server goes offline, my users can still sign up for my waitlist without friction.**

### **4\. Functional Requirements**

#### **4.1 Page Layout & UI Architecture**

* **Minimalist Composition: The page must serve as a clean container focusing strictly on conversion. It will render:**  
  * **The global workspace/product Logo centered at the top header (if uploaded).**  
  * **The Full Waitlist Widget centered directly below the logo, handling the full layout (First name, Last name, Email, Phone, and Custom Q\&A survey items).**  
  * **The post-signup success matrix (waitlist rank, cumulative count, unique referral link, and quick social-sharing actions).**

#### **4.2 Styling & Configuration Synchronization**

* **Inheritance Rules: The hosted page does not possess an independent design panel. It must dynamically read and inherit rules set within the Widget Builder configuration:**  
  * **Design Tab: Submit button colors, global text colors, backgrounds, fonts, and customizable headings/sub-headings.**  
  * **Social Tab: Social-sharing copy matrices and custom preview tags.**  
  * **Questions Tab: Active user-qualification inputs or survey blocks.**

#### **4.3 Systematic Routing & Referral Automation**

* **The "Blank URL" Routing Matrix: The backend routing handler must evaluate the waitlist's global** Waitlist URL **parameter (configured in Settings) whenever a referral link is generated:**  
  * **Scenario A (Custom Site Defined): If** Waitlist URL **\=** \[https://my-awesome-startup.com\](https://my-awesome-startup.com)**, user referral strings resolve to point directly to that custom destination.**  
  * **Scenario B (Null/Blank Parameter): If** Waitlist URL **remains unconfigured, the system must automatically format and target the unique** Hosted Page **URL (**\[https://getwaitlist.com/waitlist/\](https://getwaitlist.com/waitlist/)\<WAITLIST\_ID\>**), ensuring the referral traffic lands on a functional conversion funnel.**

#### **4.4 Dashboard Integration**

* **Location: Anchor a "Hosted Page" trigger button as the rightmost item inside the platform's standard Widget Builder navbar.**  
* **Actions: Clicking this selector should instantly open the unique live public landing page in a separate browser tab, allowing administrators to rapidly review design iterations or grab the URL string for public dissemination (social bios, email signatures, etc.).**

### **5\. Non-Functional Requirements & Plan Constraints**

* **Availability Tier: Unlike advanced marketing tools, the Hosted Page is structurally categorized as a Free / Core Feature—available to every account upon registration without paywalls.**  
* **Performance Targets: The landing environment must load within minimalist performance overheads ($\<200\\text{ms}$ DOM paint speeds) to prevent user drop-off during high-traffic viral spikes.**  
* **Mobile Responsiveness: The standalone wrapper container must employ responsive constraints ensuring optimal rendering on target displays ranging from small mobile viewports to expansive desktop surfaces.**

# **Product Requirements Document (PRD)**

## **Feature: Waitlist Real-Time Analytics Dashboard**

**Status: Draft | Target Audience: Waitlist Administrators / Marketing Managers / Data Analysts**

### **1\. Objective**

**To provide waitlist administrators with real-time, actionable insights into their growth loops, referral efficacy, channel distribution, and marketing campaign metrics. The dashboard must clearly surface signup health and attribution sources to empower data-driven decisions during a pre-launch phase.**

### **2\. Scope**

**The Analytics feature compiles data from user lifecycle actions, widget pageview triggers, and inbound URL queries. It covers:**

1. **Core Lifecycle Performance Cards: At-a-glance high-level performance indicators.**  
2. **Engagement Tracking: Time-series charts analyzing conversion performance.**  
3. **Attribution & UTM Ingestion Engines: Granular traffic origin breakdowns across standard marketing matrices.**

### **3\. User Stories**

* **As an Admin, I want to see the total number of verified and unverified signups separately so that I can gauge the true health and validity of my audience size.**  
* **As an Admin, I want to track organic signups vs. referred signups to measure how virally my waitlist loop is expanding.**  
* **As an Admin, I want to see exactly when the last successful signup and referral happened so I can monitor real-time user activity during launch hours.**  
* **As a Marketer, I want to analyze UTM parameters directly inside my waitlist dashboard so I can instantly attribute signups to specific paid campaigns, ad sets, or content channels.**  
* **As an Admin, I want to monitor raw views over time to track traffic spikes and accurately identify page conversion bottlenecks.**

### **4\. Functional Requirements**

#### **4.1 Core Signup & Lifecycle KPIs**

**The analytics interface must present a suite of immediate top-level stat blocks reflecting absolute data metrics:**

* **Total Signups: Indicates cumulative waitlist scale. If Email Verification is enabled, this indicator must strictly display *Verified* signups only.**  
* **Additional Unverified Signups: Tracks signups that have hit the database but have not yet satisfied the email verification loop (hidden/not applicable if verification rules are deactivated globally).**  
* **Total Referrals: The sum of users driven to sign up explicitly by utilizing an existing user's referral token. (Strictly tracks verified referrals if verification is active).**  
* **Total Organic Signups: Calculated dynamically as:**  
* **$$\\text{Total Signups} \- \\text{Total Referrals}$$**  
* **Representing users who arrived independently.**  
* **Total Signups Offboarded: Aggregated count of users transitioned to the offboarded status.**  
* **Last Successful Signup: Real-time relative timestamp marking the most recent addition.**  
* **Last Successful Referral: Real-time relative timestamp marking the most recent referral event.**

#### **4.2 Engagement & Traffic Origin Mechanics (Widget Exclusive)**

**⚠️ Data Collection Constraint: The following metrics rely on the pre-built embeddable widget script notifying the server upon viewport instantiation. These metrics cannot be populated via headless API architectures.**

* **Waitlist Views over Time: A chronological trend line visualizing how frequently the embedded widget container renders on target host domains.**  
* **Referrer Sources: A ranked list summarizing user transit points prior to conversion. It logs the raw top-level URL from which the user linked directly to the waitlist page.**

#### **4.3 Marketing Attribution Engines (UTM Analytics)**

**The dashboard must query and display independent data aggregation tables for each standard UTM parameter detected during widget view triggers.**

| UTM Parameter | Analytics Objective | Example Logged Entry |
| :---- | :---- | :---- |
| **UTM Source** | **Identifies specific platforms/publishers driving traffic** | twitter**,** google**,** newsletter |
| **UTM Medium** | **Identifies the marketing or sharing mechanism type** | cpc**,** bio-link**,** email |
| **UTM Campaign** | **Groups performance metrics under a specific macro initiative** | summer\_launch\_2026 |
| **UTM Content** | **Differentiates distinct creative assets or ad variations** | blue\_banner\_v2 |
| **UTM Term** | **Tracks explicit keyword triggers utilized in paid search** | best-productivity-app |

### **5\. Non-Functional Requirements & Core Restrictions**

* **Real-Time Data Ingestion: Lifecycle cards must stream updates instantly upon state mutations in the backend database.**  
* **API Agnosticism Note: Frontends leveraging raw backend API requests skip widget script tracking. The UI must include helpful warning tooltips on the *Views, Referrer Sources,* and *UTM* metrics explaining that these require the embeddable no-code widget layer to display data.**  
* **Data Scannability: Use clean horizontal sections to clearly separate high-level numbers from complex marketing attribution list views.**

# **Product Requirements Document (PRD)**

## **Feature: Waitlist Profile & Behavior Settings**

**Status: Draft | Target Audience: Waitlist Administrators / DevOps Engineers**

### **1\. Objective**

**To provide waitlist administrators with a centralized control plane to adjust backend mechanics, routing logic, security enforcement, and state changes. The settings page serves as the core operational configuration engine dictating how a waitlist treats incoming user inputs and traffic redirections.**

### **2\. Scope**

**The Settings feature aggregates system toggles across six functional pillars:**

1. **Core Identity & Availability: Basic settings (Name, Open/Closed status).**  
2. **Security & Data Sanitation: CAPTCHA and email verification controls.**  
3. **URL Routing Matrix: Destination mapping and tracking boundaries.**  
4. **Viral Loop Scoring Parameters: Referral/Gamification physics rules.**  
5. **System Notifications: Admin updates regarding list performance milestones.**  
6. **Data Destruction (Danger Zone): Destructive system reset triggers.**

### **3\. User Stories**

* **As an Admin, I want to toggle my waitlist status to "Closed" when my launch capacity is filled, immediately stopping new entries from submitting data.**  
* **As a Risk Officer, I want to enable CAPTCHA and enforce strict format checking to block spam networks, disposable domains, and automated bots.**  
* **As an Admin, I want to map a permanent** Waitlist URL **so the system accurately anchors conversion data and processes referral loops correctly.**  
* **As an Admin, I want to choose how and when I get notified about list size improvements so that my workspace inbox doesn't get overloaded with transactional emails.**  
* **As a Developer testing an architecture, I want an explicit reset toggle in the dashboard to purge sandbox entries completely without destroying my underlying form configuration.**

### **4\. Functional Requirements**

#### **4.1 Core Identity & Availability**

* **Waitlist Name: Text input to modify the public/internal designation of the instance.**  
* **Availability Toggle: A binary selection (Open vs. Closed).**  
  * ***State Open:*** **Submissions process normally.**  
  * ***State Closed:*** **Blocks write access to the signup endpoint; the widget layout reflects an "Inactive/Closed" state.**

#### **4.2 Security & Data Sanitation Rules**

* **Email Validation Engine: A system toggle that runs incoming strings through automated format checks, blocks common disposable/temporary domain patterns, and prevents obvious typos.**  
* **Email Verification Loop (Double Opt-In): When enabled, flags incoming users as "Unverified" and triggers verification emails. Users do not claim their actual numerical waitlist queue priority or score until the verification webhook returns true.**  
* **Server-Side CAPTCHA Integration: When enabled, monitors submission velocity and injects zero-friction validation tasks inline to mitigate malicious backend botting without adding manual friction for humans.**

#### **4.3 URL Routing Matrix & Whitelisting**

* **Waitlist URL Entry: A explicit text domain configuration block (e.g.,** \[https://yourwebsite.com/waitlist\](https://yourwebsite.com/waitlist)**).**  
  * **Acts as the hardcoded destination for viral referral link resolution.**  
  * **If left empty, the system runs fallback heuristic checks targeting the inbound request origin headers.**  
* **Domain Whitelisting: An explicit multi-row input field allowing admins to enumerate allowed domains (**example.com**,** localhost**, explicit IP boundaries) cleared to house embed widgets. Mitigates cross-origin framing and unauthorized form embedding.**  
  * **Offload this to Google Cloud Armor and Cloud Load Balancing HTTP Host/CORS Policies. Malicious domains or unauthorized embedding attempts should be blocked and dropped at Google's global edge network before your Cloud Run containers ever spend money processing a microsecond of compute time.**

#### **4.4 Viral Loop & Point Assignment Settings**

**Allows the administrative adjusting of gamification mechanics across three vector spaces:**

| Points Class | Action Target | Configuration Limits |
| :---- | :---- | :---- |
| **Signup Points** | **Awarded instantly upon initial baseline signup verification** | **Integers between** 0 **and** 1000 |
| **Referral Points** | **Awarded to a referrer when an invited peer successfully joins** | **Integers between** 0 **and** 1000 |
| **Social Task Points** | **Awarded when users fulfill verified auxiliary targets (e.g., social follows)** | **Integers between** 0 **and** 100 |

* **Move Up Logic Toggle: Disabling this parameter forces the list to run strictly chronologically (First-In, First-Out), transforming point scores into vanity milestones rather than positions in the queue.**

#### **4.5 System Administrative Notifications**

**Dropdown selection managing platform-to-admin telemetry updates:**

* Send Always**: Shoots an email dispatch immediately upon every individual signup action.**  
* Send on Milestone**: Batch notifications generated strictly upon breaching milestone integers ($10, 50, 100, 500, \\dots$).**  
* Never Send**: Silences transactional admin communications completely.**

#### **4.6 The Danger Zone (Data Destruction)**

**An isolated structural interface block requiring double-step confirmation actions:**

* **Delete Views: Erases historical pageview logs without modifying user accounts.**  
* **Delete Subscribers: Wipes user databases entirely while keeping configuration settings intact.**  
* **Purge Both: Performs a deep factory reset on the unique waitlist instance.**

### **5\. Non-Functional Requirements**

* **Security Isolation: The Danger Zone controls must require credential re-verification or explicit pattern matching strings (e.g., typing the waitlist name) before executing database drops.**  
* **State Propagation Latency: Setting modifications (specifically Availability and Whitelists) must propagate to edge servers instantly ($\<50\\text{ms}$) to prevent synchronization gaps.**

# **Product Requirements Document (PRD)**

## **Feature: Organization & Multi-User Administration**

**Status: Draft | Target Audience: Workspace Administrators / Platform Engineers**

### **1\. Objective**

**To provide a secure, scalable system for team collaboration and tenant resource isolation. Every account must be structured under an "Organization" (tenant workspace) rather than an individual account. This architecture allows multiple users to collaborate on waitlists, share subscription boundaries, and manage unified domain networks while ensuring strict Role-Based Access Control (RBAC).**

### **2\. Scope**

**The Organization Administration feature encompasses three primary functional areas:**

1. **Data Architecture & Tenancy Boundaries: Associating core platform objects with organizations rather than users.**  
2. **Role-Based Access Control (RBAC): Defining clear behavioral barriers between "Normal" and "Administrator" team members.**  
3. **Membership Management & Organization Merging: Inviting, updating, offboarding team members, and the deterministic database logic governing data inheritance when organizations merge.**

### **3\. User Stories**

* **As a Creator, I want my account to automatically initiate a default Organization, so I can immediately create waitlists without completing complex multi-tenant onboarding setups.**  
* **As a Normal Team Member, I want full operational access to build, modify, and export waitlist datasets, and set up webhooks/integrations, without needing access to corporate subscription billings.**  
* **As an Admin, I want to invite new colleagues to our shared workspace by email so that we can collectively supervise our pre-launch signups.**  
* **As an Admin, I want to change a user's role or remove them from the company organization if they switch positions or leave the firm.**  
* **As an Admin, I want to be protected from accidentally deleting my own account or accidentally downgrading my administrative access if no other admin is available.**

### **4\. Functional Requirements**

#### **4.1 Data Architecture & Multi-Tenancy Identity**

* **Tenant Ownership: All major system objects—including Waitlists, Subscriptions, and Domains—must link natively to the** Organization **ID tier, not to individual** User **IDs.**  
* **User Constraints: A single user account can belong to exactly one organization at any given time.**  
* **Default State Engine: Upon initial registration of a new baseline user account, the backend must programmatically instantiate a new standalone** Organization **block and assign that registering user as its primary workspace Owner/Administrator.**

#### **4.2 Role-Based Access Control (RBAC)**

**The architecture must maintain two explicit user permission tiers:**

| Capable Action | Normal Team Member | Workspace Administrator |
| :---- | :---- | :---- |
| **Create, view, edit, delete active Waitlists** | **✅** | **✅** |
| **Access, analyze, and execute CSV exports** | **✅** | **✅** |
| **Modify Webhooks, Slacks, & Discord Integrations** | **✅** | **✅** |
| **Configure associated Domains & styles** | **✅** | **✅** |
| **Invite new users / Administrate Organization Membership** | **❌** | **✅** |
| **Upgrade, modify, or cancel Billing Subscriptions** | **❌** | **✅** |

#### **4.3 Membership Management Actions**

**Administrators can perform the following modifications inside the Team Directory dashboard:**

* **Invite Member: Input an email address to dispatch an automated registration/joining invitation.**  
* **Change Role: A binary toggle between** Normal **and** Administrator **privileges.**  
* **Delete Account: Permanently removes the targeted user from the active workspace directory, ending their authentication session and disabling further platform logins.**  
* **System Integrity Guardrails:**  
  * **An authenticated user cannot delete their own account string.**  
  * **An authenticated user cannot revoke or downgrade their own administrative permission tier.**

#### **4.4  Non-Functional Requirements**

* **Security & Data Safeguards: Destructive account deletion operations or critical organization role mutations must fail cleanly if network connection errors interrupt the validation protocol.**  
* **Auditability: Changes to billing subscriptions and team member privileges must write explicit entries to system logging tables for auditing purposes.**

