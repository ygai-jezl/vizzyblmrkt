# **Product Requirement Document (PRD)**

## **Document Control**

* **Product Name:** Vizzybl AI  
* **Module:** Distribute Phase & Outbound Engagement Suite  
* **Date:** July 1, 2026  
* **Status:** Draft / Ready for Engineering Review

## **1\. Executive Summary & Objectives**

The purpose of the **Distribute Phase** module is to productize a high-velocity, multi-channel distribution engine that operates natively with AI agents. Instead of acting as a passive scheduling calendar, this module orchestrates complex publishing logic, evaluates draft quality using a predictive feedback loop, and dynamically transforms audience interactions into actionable sales pipeline inside a unified CRM.

### **Core Objectives**

* **Unified Distribution:** Provide a single-click publishing workflow for multiple target platforms (Email, Blog, X, LinkedIn, Instagram).  
* **Predictive Optimization:** Mitigate low-performing content by analyzing formatting, hook quality, and platform-specific penalties before a post goes live.  
* **Conversational Lead Conversion:** Turn viral or high-performing social impressions directly into structured CRM profiles via inbound and outbound automation.

## **2\. Epics & Functional Requirements**

### **Epic 1: Multi-Channel Scheduling & Core Rendering Engine**

#### **Calendar View vs. List View State Management**

* The system must provide a visual calendar dashboard displaying content slots organized by qualitative tags such as Educate, Observation, Thread, or Selling.  
* Users must be able to switch instantly to a linear List View tracking chronologically ordered queue entries.  
* Operators must have the manual override capability to change time slots or instantly delete any pending post from the active pipeline.

#### **Platform-Native Previews (WYSIWYG Layer)**

* The interface must render real-time, high-fidelity visual mockups of drafts exactly as they will appear on live networks.  
* **X (Twitter) Previewer:** Must track a rigid 280-character maximum length limit and display multi-part thread splits seamlessly.  
* **LinkedIn Previewer:** Must accurately truncate preview text before the native "see more" line break and render multi-page PDF document carousels.

#### **Custom Internal Cron-Job Queue Engine (LinkedIn Override)**

* Because the LinkedIn API does not natively support an asynchronous "schedule for later" parameter, the system must maintain an internal database queue.  
* A backend scheduling schema named campaign\_scheduled\_posts must store the payload parameters: id, campaign\_id, target\_platform, publish\_timestamp, payload\_body\_json, and a status tracking state flag (pending, processing, success, failed).  
* A system cron task must evaluate this table every 60 seconds, processing and executing active posts as soon as the publish\_timestamp matches or is less than the current system time.

#### **Advanced Spintax Copy Engine**

* The editing and scheduling compiler must support nested, curly-brace Spintax copy strings to prevent automated duplicate-content penalties during recycling loops.  
* *Formatting Syntax:* {Hi|Hello|Hey} this is a {fantastic|great|useful} tip.  
* The pre-processing engine must recursively scan this configuration before calling platform publishing endpoints, randomly extracting exactly one variant string for every grouped configuration block.

#### **Auto-Plug Rules**

* The distribution coordinator must allow users to define automated follow-up rules.  
* If a live parent post surpasses a specific engagement threshold within a configured timeframe (e.g., getting 50 likes in under 30 minutes), the engine must automatically append a pre-configured promotional comment or link directly underneath.

### **Epic 2: Predictive Performance & Feedback Loop Matrix**

#### **Pre-Publishing Performance Score (PPS)**

* Before any content package is approved for delivery, the copy evaluator must parse the text metrics to provide an explicit quality rating from 0 to 100\.  
* The script must calculate this baseline value by weighting four custom variables:  
* $$\\text{PPS} \= (w\_1 \\cdot S\_{\\text{brevity}}) \+ (w\_2 \\cdot S\_{\\text{formatting}}) \+ (w\_3 \\cdot S\_{\\text{keyword}}) \+ (w\_4 \\cdot S\_{\\text{hook}})$$  
* **Brevity Evaluator ($S\_{\\text{brevity}}$):** Scans character volumes, length structures, and penalizes dense walls of text.  
* **Formatting Layout ($S\_{\\text{formatting}}$):** Verifies the structural presence of white space, scannable list item arrays, and clear line breaks.  
* **Keyword Scan ($S\_{\\text{keyword}}$):** Cross-references strings against known industry spam filter blocklists and organic algorithm suppressors.  
* **Hook Assessment ($S\_{\\text{hook}}$):** Rates the psychological impact and curiosity gaps within the opening two textual sentences of the copy.

#### **Closed-Loop Performance Ingestion**

* The platform must fetch live performance metrics (impressions, likes, comments, shares) via social platform APIs exactly 48 hours post-publication.  
* The analytics pipeline must compare actual engagement numbers with the initial pre-score prediction.  
* If an item beats its baseline projections, its text structures and category configurations must be written directly to the Firestore VectorDB as an updated high-performance reference asset.  
* Future AI agent composition runs must be programmatically weighted toward the structural formatting layouts that generated the highest verified real-world engagement metrics.

### **Epic 3: Inbound Lead Capture & Unified CRM Integration**

#### **The 'Engaged' Tab Repository Interface**

* The system must extract profiles interacting with campaign updates and write them directly into a tabular interface matching the application's contact list layout.  
* The database table layout must strictly maintain and display the columns: **HANDLE**, **NAME**, **BIO**, **LOCATION**, **WEBSITE**, **FOLLOWERS**, and **FOLLOWING**.  
* Every lead row record must render a functional, high-contrast **"DM" action button** alongside a delete action shortcut button.

```

┌────────────────────────────────────────────────────────────────────────────────────────┐
│  CONTACT LIST  │  [ + Create new list ]                                 [ + Add people ]│
├────────────────────────────────────────────────────────────────────────────────────────┤
│ HANDLE       │ NAME         │ BIO          │ LOCATION   │ FOLLOWERS │ ACTIONS          │
├──────────────┼──────────────┼──────────────┼────────────┼───────────┼──────────────────┤
│ @_thecopywr… │ Eleanor | T… │ Unfiltered … │ London, UK │ 6.1k      │  [ DM ]  [ 🗑 ]   │
│ @allgoodcopy │ Glenn Fisher │ Aspiring n…  │ Manchester │ 4.7k      │  [ DM ]  [ 🗑 ]   │
└──────────────┴──────────────┴──────────────┴────────────┴───────────┴──────────────────┘

```

#### **Natural Language Lead Finder**

* The unified CRM workspace must host a text query console enabling conversational search functionality across the parsed lead data.  
* When a user submits a conversational request (e.g., *"Find freelance copywriters based in the UK with over 5k followers"*), the query layer must interpret the requirements and return matching profiles from the database repository.

#### **X Auto-DM Funnel**

* The pipeline monitor must listen for specific comment trigger phrases (e.g., "Growth") on active promotional posts.  
* Upon matching a target comment trigger event, the system task must instantly create a lead profile in the CRM database and route the user's pre-configured asset or resource download link directly to that prospect's private messages.

### **Epic 4: Outbound Engagement Suite & Intent Orchestrator**

#### **X/Twitter "Auto-Engage" Sniper System**

* The engagement suite must track the posting activity of a user-defined list containing 5 to 20 key industry profile configurations.  
* Within 60 seconds of a tracked profile publishing a new update, the system must process the text body and generate a contextually relevant, value-add comment draft.  
* This response draft must surface in a dedicated review module, allowing operators to instantly approve and publish the reply to maximize early visibility and traffic.

#### **LinkedIn Intent Orchestrator State Machine**

* When a profile engages with an active campaign update, the orchestrator must process the prospect along a visual, multi-tier relationship sequence.  
* The system logic must systematically check connection metrics and bifurcate the outreach pipeline based on clear state-machine rules:

```

                 [ Identify Liker or Commenter ]
                                │
         ┌──────────────────────┴──────────────────────┐
         ▼ (If 1st-Degree)                             ▼ (If Non-Connected)
[ Queue Direct Outreach DM ]                 [ Validate Connection Status ]
         │                                             │
[ Deliver Direct Message ]                  [ Trigger Connection Request ]
                                                       │
                                            [ Hold DM in Safety Queue ]
                                                       │
                                            (Upon Connection Acceptance)
                                                       │
                                                       ▼
                                            [ Deliver Direct Message ]

```

* **First-Degree Logic:** If the target profile is already a first-degree connection, the automation task queues a customized direct outreach sequence and fires the message payload directly into their active chat inbox.  
* **Non-Connected Logic:** If the profile is outside the user's immediate network, the engine triggers an automatic connection invite.  
* The companion outreach message must be routed into Hold DM in Safety Queue to pause delivery until connection status parameters update.  
* As soon as a live status listener confirms network connection acceptance, the orchestration task moves the message out of the safety buffer and executes Deliver Direct Message.

## **3\. Tech Stack Requirements & Architecture**

* **UI Framework:** Plain Tailwind CSS components rendering visual canvas nodes and tabular list states.  
* **Database Tier:** Firestore VectorDB storing text chunk configurations, predictive metrics scores, and the custom CRM crm\_engaged\_leads collection rows.  
* **State Hydration:** Client-side updates must run on raw fetch() patterns backed by router.refresh() to handle real-time status transitions.

