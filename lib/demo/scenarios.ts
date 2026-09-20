// Synthetic, representative DEMO scenarios. They are NOT real customer conversations. Every user turn is sent through the
// normal engine (real model, real provider counting); nothing here contains a response, a token count or a metric.
export type DemoScenario = {
  key: "enterprise" | "bakery";
  title: string; // the title is the only demo marker (no schema change)
  description: string;
  turns: string[]; // USER messages, sent in order
  complete: boolean; // false when the scenario text supplied so far ends before its intended last turn
};

export const ENTERPRISE_TURNS = [
  `I'm leading an internal project to modernize our procurement approval portal.

The current process relies heavily on email and spreadsheets.

The new system needs:
- employee purchase requests
- manager approval
- finance approval for purchases over $10,000
- procurement review for new vendors
- status tracking
- searchable request history
- audit logs

We're expecting roughly 8,000 employees across several departments.

The initial stack is React for the frontend, Node.js for the backend, and PostgreSQL 17 for application data.

Help me think through the architecture.`,
  `A few non-negotiable company requirements:

- employees must authenticate through corporate SSO
- authentication tokens must never appear in logs
- every approval action needs an audit trail
- users should only see requests they are authorized to access
- financial data must not be exposed through public links

Keep those requirements in mind for anything we design.`,
  `Can you propose the major services/modules we should build first and explain what each one owns?`,
  `Here are notes from our stakeholder meeting:

Finance wants configurable approval thresholds.
Procurement wants vendor onboarding status visible from the request.
Managers want delegated approval when they are out of office.
Security wants immutable audit events.
Employees want notifications when a request changes state.
Leadership wants reporting by department and spend category.

Can you turn this into a prioritized implementation plan?`,
  `Explain the practical difference between SAML and OAuth for an enterprise application like this.`,
  `We had another architecture review.

We're changing the application database from PostgreSQL 17 to PostgreSQL 16 because that is the version already supported by our internal platform team.

Everything else stays the same.`,
  `Our first milestone is now an eight-week internal pilot for Finance and Operations rather than a company-wide launch.

How would you adjust the rollout plan?`,
  `Here are some development logs from the approval service:

ERROR approval transition failed
request=PR-4821
state=PENDING_MANAGER
target=FINANCE_REVIEW
reason=manager approval missing

ERROR approval transition failed
request=PR-4824
state=PENDING_MANAGER
target=FINANCE_REVIEW
reason=manager approval missing

ERROR approval transition failed
request=PR-4832
state=PENDING_MANAGER
target=FINANCE_REVIEW
reason=manager approval missing

What do these failures have in common?`,
  `What other risks should I be thinking about before the pilot?`,
  `Leadership asked me for a short executive summary of the project, focusing on why we're building it, who the pilot is for, and the major controls.

Write that for me.`,
  `We've decided delegated approvals should expire automatically after seven days unless renewed.

Where should that rule live and what should we record for auditing?`,
  `Remind me what database version we're using now and what logging restriction I gave you.`,
  `What additional features could make the procurement workflow more useful after the pilot without changing the core architecture?`,
  `Give me a concise checklist of the decisions and requirements we've made so far that engineering should treat as current.`,
  `Now give me the three highest-priority things the engineering team should do next based on everything we've discussed.`,
];

export const BAKERY_TURNS = [
  `I own a small neighborhood bakery called Maple & Main Bakery.

I'm trying to vibe code our first proper website.

We sell:
- sourdough bread
- croissants
- cookies
- birthday cakes
- coffee

We're open Tuesday through Sunday from 7 AM to 3 PM and closed Monday.

I want the site to feel warm and simple, not corporate.

I need:
- homepage
- menu
- about us
- hours/location
- contact page

I'm using Next.js and React because that's what the starter project gave me.

How should I structure the site?`,
  `Our branding is cream backgrounds, dark brown text, and a muted green accent.

Please keep the design accessible and mobile friendly.

I don't want the website to look overly fancy or like a tech startup.`,
  `Can you write the structure for the homepage and tell me what sections should appear in what order?`,
  `I want people to be able to request custom birthday cakes.

I don't want to take payments online yet.

The form should collect:
- name
- email
- phone
- requested date
- number of servings
- flavor
- message

How should I build that?`,
  `Actually, our hours changed.

We're now open Tuesday through Saturday from 7 AM to 4 PM,
Sunday from 8 AM to 2 PM,
and still closed Monday.`,
  `Can you suggest a simple menu-page layout that works well on phones?

Our main categories are breads, pastries, cookies, cakes, and drinks.`,
  `I added the navigation but on mobile the links overflow off the side of the screen.

Here's the component:

\`\`\`tsx
<nav>
  <div className="nav-links">
    <a href="/">Home</a>
    <a href="/menu">Menu</a>
    <a href="/about">About</a>
    <a href="/cakes">Custom Cakes</a>
    <a href="/contact">Contact</a>
  </div>
</nav>
\`\`\``,
  `Now I'm getting this error when I submit the cake form:

POST /api/cake-request 500

TypeError: Cannot read properties of undefined (reading 'email')
at POST (app/api/cake-request/route.ts:18:31)

I see the same error every time I submit.

What should I investigate?`,
  `I fixed the request body issue.

For now, cake requests should only send us an email notification.

Do not store payment information and do not automatically charge customers.

What should the confirmation experience look like?`,
  `What's the difference between an SEO title and the big heading people see on the page?`,
  `Can you suggest SEO titles and descriptions for the homepage, menu, and custom cakes pages based on what you know about the bakery?`,
  `What other features would be useful for a small bakery website without making the site complicated?`,
  `I'd like to add a section showing today's featured items.

It should be easy for me to update without editing five different files.

What's the simplest architecture for that?`,
  `Remind me of our current business hours and the rule we decided on for cake payments.`,
  `We're almost ready to launch.

Give me a launch checklist covering mobile usability, accessibility, forms, SEO, security, and the bakery information we've discussed.`,
  `Based on everything we've built, what are the three improvements you would prioritize after launch?`,
];

export const SCENARIOS: DemoScenario[] = [
  { key: "enterprise", title: "Demo — Enterprise Employee", description: "Synthetic demo scenario: a project lead modernizing a procurement approval portal (15 turns).", turns: ENTERPRISE_TURNS, complete: true },
  { key: "bakery", title: "Demo — Mom & Pop Website", description: "Synthetic demo scenario: a bakery owner building a website with an AI assistant (16 turns).", turns: BAKERY_TURNS, complete: true },
];
