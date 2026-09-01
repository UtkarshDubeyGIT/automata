import type { WorkflowGraph } from "./types";

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: "Lead management" | "Communication" | "Data sync" | "Commerce" | "Content" | "Operations";
  apps: string[];
  risk: "routine" | "external_write";
  setupMinutes: number;
  graph: WorkflowGraph;
}

export const TEMPLATES: WorkflowTemplate[] = [
  {
    id: "sheet-to-personal-email",
    name: "Send personalized email from a new row",
    description: "Watch a lead sheet, draft a useful message, and send it after review.",
    category: "Lead management",
    apps: ["googlesheets", "gmail"],
    risk: "external_write",
    setupMinutes: 4,
    graph: { start: "row", steps: {
      row: { id: "row", type: "app_event_trigger", name: "New row in Google Sheets", app: "googlesheets", event: "NEW_ROW", next: "draft" },
      draft: { id: "draft", type: "ai", name: "Draft a personal email", instruction: "Write a concise email using the new row fields.", next: "approve" },
      approve: { id: "approve", type: "approval", name: "Review the email", prompt: "Send this email?", onApprove: "send", onReject: null, next: null },
      send: { id: "send", type: "app_action", name: "Send with Gmail", app: "gmail", action: "GMAIL_SEND_EMAIL", operation: "write", next: null },
    } },
  },
  {
    id: "important-email-slack",
    name: "Summarize important email in Slack",
    description: "Detect priority messages, summarize the request, and route it to the right channel.",
    category: "Communication",
    apps: ["gmail", "slack"],
    risk: "external_write",
    setupMinutes: 3,
    graph: { start: "email", steps: {
      email: { id: "email", type: "app_event_trigger", name: "Important email received", app: "gmail", event: "NEW_EMAIL", next: "summary" },
      summary: { id: "summary", type: "ai", name: "Summarize and classify", instruction: "Summarize the request and assign urgency.", next: "approve" },
      approve: { id: "approve", type: "approval", name: "Review Slack alert", prompt: "Post this summary to Slack?", onApprove: "post", onReject: null, next: null },
      post: { id: "post", type: "app_action", name: "Post to Slack", app: "slack", action: "SLACK_SEND_MESSAGE", operation: "write", next: null },
    } },
  },
  {
    id: "email-attachments-drive",
    name: "Archive email attachments",
    description: "Save matching attachments to Drive and add a searchable row to Sheets.",
    category: "Data sync",
    apps: ["gmail", "googledrive", "googlesheets"],
    risk: "routine",
    setupMinutes: 5,
    graph: { start: "email", steps: {
      email: { id: "email", type: "app_event_trigger", name: "Email with attachment", app: "gmail", event: "NEW_ATTACHMENT", next: "upload" },
      upload: { id: "upload", type: "app_action", name: "Upload to Drive", app: "googledrive", action: "GOOGLEDRIVE_UPLOAD_FILE", operation: "write", next: "log" },
      log: { id: "log", type: "app_action", name: "Add archive row", app: "googlesheets", action: "GOOGLESHEETS_ADD_ROW", operation: "write", next: null },
    } },
  },
  {
    id: "webhook-hubspot-lead",
    name: "Capture a lead in HubSpot",
    description: "Accept a form webhook, normalize the fields, and create a contact after review.",
    category: "Lead management",
    apps: ["hubspot", "slack"],
    risk: "external_write",
    setupMinutes: 5,
    graph: { start: "lead", steps: {
      lead: { id: "lead", type: "webhook_trigger", name: "Lead webhook", next: "map" },
      map: { id: "map", type: "transform", name: "Map lead fields", next: "approve" },
      approve: { id: "approve", type: "approval", name: "Approve new contact", prompt: "Create this contact in HubSpot?", onApprove: "create", onReject: null, next: null },
      create: { id: "create", type: "app_action", name: "Create HubSpot contact", app: "hubspot", action: "HUBSPOT_CREATE_CONTACT", operation: "write", next: "notify" },
      notify: { id: "notify", type: "app_action", name: "Notify sales in Slack", app: "slack", action: "SLACK_SEND_MESSAGE", operation: "write", next: null },
    } },
  },
  {
    id: "shopify-whatsapp-order",
    name: "Send a WhatsApp order alert",
    description: "Turn each new Shopify order into a concise operations alert.",
    category: "Commerce",
    apps: ["shopify", "whatsapp"],
    risk: "external_write",
    setupMinutes: 4,
    graph: { start: "order", steps: {
      order: { id: "order", type: "app_event_trigger", name: "New Shopify order", app: "shopify", event: "NEW_ORDER", next: "format" },
      format: { id: "format", type: "transform", name: "Format order summary", next: "approve" },
      approve: { id: "approve", type: "approval", name: "Review WhatsApp alert", prompt: "Send this order alert?", onApprove: "send", onReject: null, next: null },
      send: { id: "send", type: "app_action", name: "Send WhatsApp message", app: "whatsapp", action: "WHATSAPP_SEND_MESSAGE", operation: "write", next: null },
    } },
  },
  {
    id: "shopify-sales-sheet",
    name: "Log Shopify orders in Sheets",
    description: "Maintain a clean order ledger without copying customer and revenue data by hand.",
    category: "Commerce",
    apps: ["shopify", "googlesheets"],
    risk: "routine",
    setupMinutes: 3,
    graph: { start: "order", steps: {
      order: { id: "order", type: "app_event_trigger", name: "New Shopify order", app: "shopify", event: "NEW_ORDER", next: "map" },
      map: { id: "map", type: "transform", name: "Select order fields", next: "append" },
      append: { id: "append", type: "app_action", name: "Append order row", app: "googlesheets", action: "GOOGLESHEETS_ADD_ROW", operation: "write", next: null },
    } },
  },
  {
    id: "calendar-whatsapp-reminder",
    name: "Send meeting reminders on WhatsApp",
    description: "Find tomorrow's appointments and prepare a reminder for each attendee.",
    category: "Communication",
    apps: ["googlecalendar", "whatsapp"],
    risk: "external_write",
    setupMinutes: 6,
    graph: { start: "schedule", steps: {
      schedule: { id: "schedule", type: "schedule_trigger", name: "Every evening", cron: "0 18 * * *", next: "events" },
      events: { id: "events", type: "app_action", name: "Find tomorrow's events", app: "googlecalendar", action: "GOOGLECALENDAR_FIND_EVENTS", operation: "read", next: "each" },
      each: { id: "each", type: "iterator", name: "For each attendee", next: "approve" },
      approve: { id: "approve", type: "approval", name: "Approve reminders", prompt: "Send these appointment reminders?", onApprove: "send", onReject: null, next: null },
      send: { id: "send", type: "app_action", name: "Send WhatsApp reminder", app: "whatsapp", action: "WHATSAPP_SEND_TEMPLATE", operation: "write", next: null },
    } },
  },
  {
    id: "airtable-notion-sync",
    name: "Sync approved Airtable records to Notion",
    description: "Create a Notion page whenever a record reaches its approved state.",
    category: "Data sync",
    apps: ["airtable", "notion"],
    risk: "routine",
    setupMinutes: 4,
    graph: { start: "record", steps: {
      record: { id: "record", type: "app_event_trigger", name: "Airtable record updated", app: "airtable", event: "UPDATED_RECORD", next: "approved" },
      approved: { id: "approved", type: "filter", name: "Status is approved", next: "page", onFalse: null },
      page: { id: "page", type: "app_action", name: "Create Notion page", app: "notion", action: "NOTION_CREATE_PAGE", operation: "write", next: null },
    } },
  },
  {
    id: "github-issue-triage",
    name: "Triage urgent GitHub issues",
    description: "Classify new issues and route urgent cases to an engineering Slack channel.",
    category: "Operations",
    apps: ["github", "slack"],
    risk: "external_write",
    setupMinutes: 4,
    graph: { start: "issue", steps: {
      issue: { id: "issue", type: "app_event_trigger", name: "New GitHub issue", app: "github", event: "NEW_ISSUE", next: "classify" },
      classify: { id: "classify", type: "ai", name: "Assess urgency", instruction: "Classify outages, data loss, security, or payment failures as urgent.", next: "urgent" },
      urgent: { id: "urgent", type: "filter", name: "Only urgent issues", next: "approve", onFalse: null },
      approve: { id: "approve", type: "approval", name: "Review escalation", prompt: "Escalate this issue in Slack?", onApprove: "post", onReject: null, next: null },
      post: { id: "post", type: "app_action", name: "Post urgent issue", app: "slack", action: "SLACK_SEND_MESSAGE", operation: "write", next: null },
    } },
  },
  {
    id: "sheet-linkedin-publisher",
    name: "Publish approved LinkedIn drafts",
    description: "Turn a content-sheet row into a polished post and keep final approval human.",
    category: "Content",
    apps: ["googlesheets", "linkedin"],
    risk: "external_write",
    setupMinutes: 5,
    graph: { start: "draft", steps: {
      draft: { id: "draft", type: "app_event_trigger", name: "New content row", app: "googlesheets", event: "NEW_ROW", next: "polish" },
      polish: { id: "polish", type: "ai", name: "Polish the LinkedIn post", instruction: "Improve clarity without inventing facts or metrics.", next: "approve" },
      approve: { id: "approve", type: "approval", name: "Approve LinkedIn post", prompt: "Publish this post to LinkedIn?", onApprove: "publish", onReject: null, next: null },
      publish: { id: "publish", type: "app_action", name: "Publish to LinkedIn", app: "linkedin", action: "LINKEDIN_CREATE_POST", operation: "write", next: null },
    } },
  },
  {
    id: "telegram-notion-capture",
    name: "Capture Telegram ideas in Notion",
    description: "Turn messages sent to your bot into organized notes with useful tags.",
    category: "Data sync",
    apps: ["telegram", "notion"],
    risk: "routine",
    setupMinutes: 3,
    graph: { start: "message", steps: {
      message: { id: "message", type: "app_event_trigger", name: "Telegram bot message", app: "telegram", event: "NEW_MESSAGE", next: "structure" },
      structure: { id: "structure", type: "ai", name: "Title and tag the idea", instruction: "Return a clear title, summary, and up to three tags.", next: "save" },
      save: { id: "save", type: "app_action", name: "Create Notion page", app: "notion", action: "NOTION_CREATE_PAGE", operation: "write", next: null },
    } },
  },
  {
    id: "daily-pipeline-digest",
    name: "Send a daily pipeline digest",
    description: "Summarize open HubSpot deals and deliver the decisions that matter to Slack.",
    category: "Lead management",
    apps: ["hubspot", "slack"],
    risk: "external_write",
    setupMinutes: 4,
    graph: { start: "morning", steps: {
      morning: { id: "morning", type: "schedule_trigger", name: "Weekdays at 9:00", cron: "0 9 * * 1-5", next: "deals" },
      deals: { id: "deals", type: "app_action", name: "Read open deals", app: "hubspot", action: "HUBSPOT_LIST_DEALS", operation: "read", next: "summary" },
      summary: { id: "summary", type: "ai", name: "Write the daily digest", instruction: "Summarize movement, stalled deals, and next actions without inventing data.", next: "approve" },
      approve: { id: "approve", type: "approval", name: "Review pipeline digest", prompt: "Post this digest to Slack?", onApprove: "post", onReject: null, next: null },
      post: { id: "post", type: "app_action", name: "Post to Slack", app: "slack", action: "SLACK_SEND_MESSAGE", operation: "write", next: null },
    } },
  },
];
