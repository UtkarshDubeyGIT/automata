import type { IconName } from "@/components/ui/icon";
import type { WorkflowGraph } from "./types";

/**
 * Ready-made automations — the fastest of the three ways to build one
 * (template → visual editor → AI chat). Each template is an ordinary graph:
 * picking one creates a real workflow you then edit like any other, rather
 * than a special "template mode".
 *
 * Templates are deliberately allowed to ship with blanks (a Slack channel, a
 * spreadsheet id). Those surface as "Needs setup" on the step card, which is
 * the point — it tells the user exactly what to fill in.
 */

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  icon: IconName;
  /** Toolkit slug for the card logo. */
  app?: string;
  apps?: string[];
  category?: string;
  risk?: "routine" | "external_write";
  setupMinutes?: number;
  /** Short chips shown on the card. */
  tags: string[];
  graph: WorkflowGraph;
}

export const TEMPLATES: WorkflowTemplate[] = [
  {
    id: "notetaker-vikunja-tasks",
    name: "Turn meeting actions into Vikunja tasks",
    description: "Receive a completed Notetaker transcript, extract every action item, and create one unassigned Vikunja task per item.",
    icon: "check-square",
    app: "vikunja",
    apps: ["vikunja"],
    category: "Project management",
    risk: "external_write",
    setupMinutes: 4,
    tags: ["Notetaker", "Meeting", "Tasks", "Vikunja"],
    graph: {
      start: "meeting_complete",
      steps: {
        meeting_complete: {
          type: "webhook_trigger",
          title: "When the transcript is ready",
          stage: "Trigger",
          secret: "",
          next: "extract_actions",
        },
        extract_actions: {
          type: "meeting_summary",
          title: "Extract meeting action items",
          stage: "Extract",
          transcript_field: "data.transcript",
          extract_action_items: true,
          next: "create_tasks",
        },
        create_tasks: {
          type: "app_action",
          title: "Create Vikunja tasks",
          stage: "Create",
          toolkit: "vikunja",
          tool: "VIKUNJA_CREATE_TASKS",
          arguments: {
            project_id: "",
            items: "{{steps.extract_actions.actionItems}}",
            meeting_title: "{{steps.meeting_complete.body.data.meeting.title}}",
            meeting_id: "{{steps.meeting_complete.body.data.meeting.id}}",
          },
          next: null,
        },
      },
    },
  },
  {
    id: "meeting-whatsapp-summary",
    name: "Meeting brief on WhatsApp",
    description:
      "Summarize a completed meeting, add related Gmail and Calendar context, and send one concise WhatsApp brief.",
    icon: "message-circle",
    app: "whatsapp",
    apps: ["whatsapp", "gmail", "googlecalendar"],
    category: "Communication",
    risk: "external_write",
    setupMinutes: 5,
    tags: ["Meeting", "Gmail", "Calendar", "WhatsApp"],
    graph: {
      start: "meeting_complete",
      steps: {
        meeting_complete: {
          type: "webhook_trigger",
          title: "When the meeting transcript is ready",
          stage: "Trigger",
          secret: "",
          next: "meeting_summary",
        },
        meeting_summary: {
          type: "meeting_summary",
          title: "Summarize the meeting",
          stage: "Summarize",
          transcript_field: "data.transcript",
          next: "related_email",
        },
        related_email: {
          type: "app_action",
          title: "Find related emails",
          stage: "Context",
          toolkit: "gmail",
          tool: "GMAIL_FETCH_EMAILS",
          arguments: { query: "{{steps.meeting_complete.body.email_query}}", verbose: true, ids_only: false },
          next: "calendar_tasks",
        },
        calendar_tasks: {
          type: "app_action",
          title: "Read related calendar tasks",
          stage: "Context",
          toolkit: "googlecalendar",
          tool: "GOOGLECALENDAR_EVENTS_LIST",
          arguments: {
            q: "{{steps.meeting_complete.body.calendar_query}}",
            timeMin: "{{steps.meeting_complete.body.time_min}}",
            timeMax: "{{steps.meeting_complete.body.time_max}}",
          },
          next: "compose_brief",
        },
        compose_brief: {
          type: "ai_step",
          title: "Compose the WhatsApp brief",
          stage: "Synthesize",
          instruction:
            "Create a concise operational WhatsApp brief from the meeting summary, related emails, and calendar items below. Lead with decisions, then action items with owners and dates. Include only facts present in the inputs. Plain text, under 700 characters, no secrets or quoted email bodies.\n\nMeeting:\n{{steps.meeting_summary.text}}\n\nRelated email context:\n{{steps.related_email.text}}\n\nCalendar context:\n{{steps.calendar_tasks.text}}",
          output: "text",
          next: "send_whatsapp",
        },
        send_whatsapp: {
          type: "whatsapp_reminder",
          title: "Send the brief on WhatsApp",
          stage: "Notify",
          message: "{{steps.compose_brief.text}}\n\nOpen the workflow run in Automata for details.",
          next: null,
        },
      },
    },
  },
  {
    id: "google-review-replies",
    name: "Reply to Google reviews",
    description:
      "Classify every new review, draft a reply in your voice, and post it back to your Business Profile.",
    icon: "message",
    app: "googlebusinessprofile",
    apps: ["googlebusinessprofile"],
    category: "Customer support",
    risk: "external_write",
    setupMinutes: 4,
    tags: ["Trigger", "AI", "Auto-reply"],
    graph: {
      start: "new_review",
      steps: {
        new_review: {
          type: "app_event_trigger",
          title: "When a customer leaves a Google review",
          stage: "Trigger",
          app: "googlebusinessprofile",
          event: "NEW_GOOGLE_REVIEW",
          interval_minutes: 60,
          next: "classify_review",
        },
        classify_review: {
          type: "ai_step",
          title: "Read the sentiment",
          stage: "Process",
          instruction:
            "Classify this review as positive, negative, or neutral. Review rating: {{steps.new_review.event.rating}}. Review text: {{steps.new_review.event.text}}",
          output: "json",
          schema: { category: "positive | negative | neutral" },
          branch_on: "category",
          cases: { positive: "draft_positive", negative: "draft_negative" },
          default: "draft_neutral",
        },
        draft_positive: {
          type: "ai_step",
          title: "Draft a thank-you",
          stage: "Draft",
          instruction:
            "Write a short, warm public reply thanking {{steps.new_review.event.reviewer}} for their review: {{steps.new_review.event.text}}. Two sentences, no emoji, no hashtags.",
          output: "json",
          schema: { reply: "the public reply text" },
          next: "post_positive",
        },
        draft_negative: {
          type: "ai_step",
          title: "Draft a recovery reply",
          stage: "Draft",
          instruction:
            "Write a calm, non-defensive public reply to this critical review from {{steps.new_review.event.reviewer}}: {{steps.new_review.event.text}}. Acknowledge the issue, apologise once, and invite them to get in touch. Never argue, never make promises about refunds.",
          output: "json",
          schema: { reply: "the public reply text" },
          next: "approve_negative",
        },
        draft_neutral: {
          type: "ai_step",
          title: "Draft a friendly reply",
          stage: "Draft",
          instruction:
            "Write a brief, friendly public reply to this review from {{steps.new_review.event.reviewer}}: {{steps.new_review.event.text}}. Two sentences.",
          output: "json",
          schema: { reply: "the public reply text" },
          next: "post_neutral",
        },
        approve_negative: {
          type: "human_approval",
          title: "Check the reply before it goes public",
          stage: "Review",
          prompt: "Approve this reply to a critical review?",
          on_approve: "post_negative",
          on_reject: null,
        },
        post_positive: {
          type: "app_action",
          title: "Post the reply",
          stage: "Act",
          toolkit: "googlebusinessprofile",
          tool: "GOOGLEBUSINESS_REPLY_TO_REVIEW",
          arguments: {
            review_id: "{{steps.new_review.event.review_id}}",
            reply: "{{steps.draft_positive.result.reply}}",
          },
          next: null,
        },
        post_negative: {
          type: "app_action",
          title: "Post the reply",
          stage: "Act",
          toolkit: "googlebusinessprofile",
          tool: "GOOGLEBUSINESS_REPLY_TO_REVIEW",
          arguments: {
            review_id: "{{steps.new_review.event.review_id}}",
            reply: "{{steps.draft_negative.result.reply}}",
          },
          next: null,
        },
        post_neutral: {
          type: "app_action",
          title: "Post the reply",
          stage: "Act",
          toolkit: "googlebusinessprofile",
          tool: "GOOGLEBUSINESS_REPLY_TO_REVIEW",
          arguments: {
            review_id: "{{steps.new_review.event.review_id}}",
            reply: "{{steps.draft_neutral.result.reply}}",
          },
          next: null,
        },
      },
    },
  },

  {
    id: "daily-linkedin-post",
    name: "Daily LinkedIn post",
    description:
      "Every weekday morning, draft a founder-voice post and publish it once you approve.",
    icon: "send",
    app: "linkedin",
    apps: ["linkedin"],
    category: "Content",
    risk: "external_write",
    setupMinutes: 5,
    tags: ["Schedule", "AI", "Approval"],
    graph: {
      start: "every_morning",
      steps: {
        every_morning: {
          type: "schedule_trigger",
          title: "Every weekday at 09:00",
          stage: "Trigger",
          cadence: "weekly",
          weekdays: [1, 2, 3, 4, 5],
          hour: 9,
          next: "draft_post",
        },
        draft_post: {
          type: "ai_step",
          title: "Draft today's post",
          stage: "Draft",
          /**
           * The subject comes from the workspace, not from here.
           *
           * This was the one instruction in the library that named a topic:
           * "about building an AI-native growth team". Every other template
           * writes about data the run actually carries — a review, an order,
           * an issue — while this one shipped an opinion about staffing to
           * whoever installed it. A solo engineer's portfolio published a post
           * advising its readers on hiring data scientists, in the plural
           * voice a growth team implies, on the founder's own LinkedIn.
           *
           * `ai_step` prepends `brandContext`, so "this business" resolves to
           * the real one. When the profile is empty that block is absent and
           * the sentence still reads — the model then has nothing to be
           * specific about, which is the honest outcome.
           */
          instruction:
            "Write one LinkedIn post about this business — what it does, who it is for, or something concrete about building it. Take the subject from the brand context above; do not invent a topic, a team, a milestone or a metric it does not give you. Lead with a concrete observation, keep it under 120 words, no hashtags, no emoji, and end on a question.",
          output: "json",
          schema: { text: "the post body" },
          next: "approve_post",
        },
        approve_post: {
          type: "human_approval",
          title: "Approve before publishing",
          stage: "Review",
          prompt: "Publish this post to LinkedIn?",
          on_approve: "publish_post",
          on_reject: "record_skip",
        },
        publish_post: {
          type: "social_post",
          title: "Publish to LinkedIn",
          stage: "Publish",
          platform: "linkedin",
          text: "{{steps.draft_post.result.text}}",
          next: null,
        },
        record_skip: {
          type: "log_action",
          title: "Note that it was skipped",
          stage: "Finish",
          label: "skipped",
          message: "Draft rejected — nothing was published today.",
          next: null,
        },
      },
    },
  },

  {
    id: "weekly-growth-digest",
    name: "Weekly growth digest",
    description:
      "Pull the week's Shopify orders every Monday, summarize the numbers, and drop them in Slack.",
    icon: "database",
    app: "shopify",
    apps: ["shopify", "slack"],
    category: "Communication",
    risk: "external_write",
    setupMinutes: 3,
    tags: ["Schedule", "Shopify", "Slack"],
    graph: {
      start: "every_monday",
      steps: {
        every_monday: {
          type: "schedule_trigger",
          title: "Every Monday at 08:00",
          stage: "Trigger",
          cadence: "weekly",
          weekdays: [1],
          hour: 8,
          next: "fetch_orders",
        },
        fetch_orders: {
          type: "app_action",
          title: "Fetch recent orders",
          stage: "Fetch",
          toolkit: "shopify",
          tool: "SHOPIFY_GET_ORDER_LIST",
          // The provider declares no input fields for this tool.
          arguments: {},
          next: "summarize_week",
        },
        summarize_week: {
          type: "ai_step",
          title: "Summarize the week",
          stage: "Process",
          instruction:
            "Summarize this week's orders for a founder: total orders, standout products, and one thing worth acting on. Keep it to four short bullet points. Data: {{steps.fetch_orders.text}}",
          output: "json",
          schema: { text: "the digest, as markdown bullets" },
          next: "post_digest",
        },
        post_digest: {
          type: "social_post",
          title: "Post the digest to Slack",
          stage: "Publish",
          platform: "slack",
          text: "*Weekly growth digest*\n{{steps.summarize_week.result.text}}",
          options: { channel: "" },
          next: null,
        },
      },
    },
  },

  {
    id: "urgent-issue-triage",
    name: "Triage urgent GitHub issues",
    description:
      "Score every new issue, ignore the routine ones, and email you only when something is urgent.",
    icon: "workflow",
    app: "github",
    apps: ["github", "gmail"],
    category: "Operations",
    risk: "external_write",
    setupMinutes: 4,
    tags: ["Trigger", "Filter", "Email"],
    graph: {
      start: "new_issue",
      steps: {
        new_issue: {
          type: "app_event_trigger",
          title: "When an issue is opened",
          stage: "Trigger",
          app: "github",
          event: "NEW_GITHUB_ISSUE",
          interval_minutes: 30,
          next: "score_issue",
        },
        score_issue: {
          type: "ai_step",
          title: "Judge how urgent it is",
          stage: "Process",
          instruction:
            "Decide how urgent this GitHub issue is. Title: {{steps.new_issue.event.title}}. Body: {{steps.new_issue.event.body}}. Answer 'urgent' only for outages, data loss, security, or checkout/payment breakage.",
          output: "json",
          schema: { urgency: "urgent | normal", reason: "one sentence explaining the call" },
          next: "only_urgent",
        },
        only_urgent: {
          type: "filter",
          title: "Only continue if it's urgent",
          stage: "Filter",
          source: "{{steps.score_issue.result.urgency}}",
          operator: "equals",
          value: "urgent",
          next: "email_me",
          on_fail: null,
        },
        email_me: {
          type: "app_action",
          title: "Email me the details",
          stage: "Act",
          toolkit: "gmail",
          tool: "GMAIL_SEND_EMAIL",
          arguments: {
            recipient_email: "",
            subject: "Urgent issue: {{steps.new_issue.event.title}}",
            body: "{{steps.score_issue.result.reason}}\n\n{{steps.new_issue.event.body}}",
          },
          next: null,
        },
      },
    },
  },

  {
    id: "order-thank-you",
    name: "Thank every new customer",
    description:
      "When an order comes in, write a personal thank-you email and send it automatically.",
    icon: "heart",
    app: "shopify",
    apps: ["shopify", "gmail"],
    category: "Commerce",
    risk: "external_write",
    setupMinutes: 4,
    tags: ["Trigger", "AI", "Gmail"],
    graph: {
      start: "new_order",
      steps: {
        new_order: {
          type: "app_event_trigger",
          title: "When a new order is placed",
          stage: "Trigger",
          app: "shopify",
          event: "NEW_SHOPIFY_ORDER",
          interval_minutes: 30,
          next: "draft_thanks",
        },
        draft_thanks: {
          type: "ai_step",
          title: "Write the thank-you",
          stage: "Draft",
          instruction:
            "Write a short, genuine thank-you email to {{steps.new_order.event.customer}} for ordering {{steps.new_order.event.items}}. Warm, specific, under 90 words, no discount codes, no marketing.",
          output: "json",
          schema: { subject: "email subject line", body: "email body" },
          next: "send_thanks",
        },
        send_thanks: {
          type: "app_action",
          title: "Send it",
          stage: "Act",
          toolkit: "gmail",
          tool: "GMAIL_SEND_EMAIL",
          arguments: {
            recipient_email: "",
            subject: "{{steps.draft_thanks.result.subject}}",
            body: "{{steps.draft_thanks.result.body}}",
          },
          next: null,
        },
      },
    },
  },

  {
    id: "shopify-order-whatsapp",
    name: "WhatsApp me on every new order",
    description:
      "When a new order lands in Shopify, send yourself a short WhatsApp with who bought what.",
    icon: "message",
    app: "whatsapp",
    apps: ["shopify", "whatsapp"],
    category: "Commerce",
    risk: "external_write",
    setupMinutes: 4,
    tags: ["Trigger", "AI", "WhatsApp"],
    graph: {
      start: "new_order",
      steps: {
        new_order: {
          type: "app_event_trigger",
          title: "When a new order is placed",
          stage: "Trigger",
          app: "shopify",
          event: "NEW_SHOPIFY_ORDER",
          interval_minutes: 15,
          next: "write_alert",
        },
        write_alert: {
          type: "ai_step",
          title: "Write the alert",
          stage: "Draft",
          instruction:
            "Write a one-line WhatsApp alert about a new order: {{steps.new_order.event.customer}} bought {{steps.new_order.event.items}} for {{steps.new_order.event.total}}. This is an operational notification only: do not add a promotion, discount, offer, or call to action. Plain text, under 140 characters, no emoji, no greeting.",
          output: "json",
          schema: { message: "the alert text" },
          next: "send_alert",
        },
        send_alert: {
          type: "whatsapp_reminder",
          title: "Send it on WhatsApp",
          stage: "Notify",
          message: "{{steps.write_alert.result.message}}",
          next: null,
        },
      },
    },
  },

  {
    id: "daily-meta-ads-report",
    name: "Daily Meta Ads report",
    description:
      "Every morning, read yesterday's Meta Ads numbers and email you what changed and why.",
    icon: "target",
    app: "metaads",
    apps: ["metaads", "gmail"],
    category: "Operations",
    risk: "external_write",
    setupMinutes: 3,
    tags: ["Schedule", "Meta Ads", "Gmail"],
    graph: {
      start: "every_morning",
      steps: {
        every_morning: {
          type: "schedule_trigger",
          title: "Every morning at 10:00",
          stage: "Trigger",
          cadence: "daily",
          hour: 10,
          next: "read_insights",
        },
        read_insights: {
          type: "app_action",
          title: "Read yesterday's Meta Ads numbers",
          stage: "Fetch",
          toolkit: "metaads",
          tool: "METAADS_GET_INSIGHTS",
          // object_id blank on purpose: it is autofilled from Settings → Paid
          // channels. `level` and `fields` are tool constants and are filled
          // server-side — an array here would be stringified by the arguments
          // editor the first time anyone opened this step.
          arguments: { object_id: "", date_preset: "yesterday" },
          next: "write_report",
        },
        write_report: {
          type: "ai_step",
          title: "Write the report",
          stage: "Draft",
          instruction:
            "Here are yesterday's Meta Ads numbers:\n\n{{steps.read_insights.text}}\n\nWrite a short daily report. Lead with spend and what it bought. Call out anything that moved sharply. Use only the numbers above — never estimate CPA, ROAS or conversions if they are not there. Under 150 words.",
          output: "json",
          schema: { subject: "email subject line", body: "the report" },
          next: "email_report",
        },
        email_report: {
          type: "app_action",
          title: "Email it to you",
          stage: "Act",
          toolkit: "gmail",
          tool: "GMAIL_SEND_EMAIL",
          arguments: {
            recipient_email: "",
            subject: "{{steps.write_report.result.subject}}",
            body: "{{steps.write_report.result.body}}",
          },
          next: null,
        },
      },
    },
  },

  {
    id: "weekly-product-reel",
    name: "Weekly product reel",
    description:
      "Every Monday, film a short branded clip and publish it to Instagram as a Reel once you approve.",
    icon: "video",
    app: "instagram",
    apps: ["instagram"],
    category: "Content",
    risk: "external_write",
    setupMinutes: 6,
    tags: ["Schedule", "AI", "Video", "Approval"],
    graph: {
      start: "every_monday",
      steps: {
        every_monday: {
          type: "schedule_trigger",
          title: "Every Monday at 10:00",
          stage: "Trigger",
          cadence: "weekly",
          weekdays: [1],
          hour: 10,
          next: "plan_the_clip",
        },
        plan_the_clip: {
          type: "ai_step",
          title: "Write the scene and the caption",
          stage: "Draft",
          /**
           * Two outputs, on purpose: the `scene` is what the camera sees and
           * the `caption` is what is read under it, and they are written
           * together so they are about the same thing. Both take their subject
           * from the brand context `ai_step` prepends — the same rule the
           * LinkedIn template learned the hard way. Naming a topic here would
           * ship an opinion to whoever installed this.
           */
          instruction:
            "Plan one short video about this business. Return a 'scene': one concrete, filmable image — a product, a place, a pair of hands doing something real — with no text, captions or logos in it, described in under 40 words. Also return a 'caption': under 30 words, plain, no hashtags. Take the subject from the brand context above; do not invent a product, a team, a milestone or a metric it does not give you.",
          output: "json",
          schema: { scene: "what the camera sees", caption: "the words under it" },
          next: "film_the_clip",
        },
        film_the_clip: {
          type: "generate_video",
          title: "Film the clip",
          stage: "Draft",
          /**
           * Before the approval, never after it. The run genuinely stops here
           * for several minutes while the render happens and resumes itself
           * when the clip lands — so an approval placed above this would ask
           * somebody to approve a video that does not exist yet.
           */
          prompt: "{{steps.plan_the_clip.result.scene}}",
          kind: "shortform",
          aspectRatio: "9:16",
          durationSec: 10,
          next: "approve_the_clip",
        },
        approve_the_clip: {
          type: "human_approval",
          title: "Watch it before it goes out",
          stage: "Review",
          prompt: "Publish this Reel to Instagram?",
          on_approve: "publish_the_reel",
          on_reject: "record_skip",
        },
        publish_the_reel: {
          type: "social_post",
          title: "Publish to Instagram",
          stage: "Publish",
          platform: "instagram",
          text: "{{steps.plan_the_clip.result.caption}}",
          // An .mp4 in `mediaUrl` is what makes this a Reel rather than a
          // photo post — see the publisher's media_type switch.
          mediaUrl: "{{steps.film_the_clip.url}}",
          next: null,
        },
        record_skip: {
          type: "log_action",
          title: "Note that it was skipped",
          stage: "Finish",
          label: "skipped",
          message: "Clip rejected — nothing was published this week.",
          next: null,
        },
      },
    },
  },

  {
    id: "blank",
    name: "Start from scratch",
    description: "An empty canvas with a manual trigger — add steps yourself.",
    icon: "plus",
    apps: [],
    category: "Custom",
    risk: "routine",
    setupMinutes: 1,
    tags: ["Blank"],
    graph: {
      start: "start",
      steps: {
        start: {
          type: "manual_trigger_input",
          title: "Run manually",
          stage: "Trigger",
          fields: [],
          next: null,
        },
      },
    },
  },
];

export function getTemplate(id: string): WorkflowTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
