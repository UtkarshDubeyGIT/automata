-- Workflows created from the "Turn meeting actions into Vikunja tasks" template
-- before the Notetaker envelope fix still reference the flat body shape
-- (`body.meeting_id`, `body.title`, `transcript`). Notetaker wraps every
-- delivery as `{ data: { meeting: { id, title }, transcript } }`, so those
-- runs fail at the Vikunja step with an unresolved reference. The template
-- itself is already corrected; this repoints the saved graphs. Every update is
-- guarded by an exact match on the stale value, so it is safe to re-run.

update public.workflows
   set config = replace(config::text,
                        '{{steps.meeting_complete.body.meeting_id}}',
                        '{{steps.meeting_complete.body.data.meeting.id}}')::jsonb
 where position('{{steps.meeting_complete.body.meeting_id}}' in config::text) > 0;

update public.workflows
   set config = replace(config::text,
                        '{{steps.meeting_complete.body.title}}',
                        '{{steps.meeting_complete.body.data.meeting.title}}')::jsonb
 where position('{{steps.meeting_complete.body.title}}' in config::text) > 0;

update public.workflows
   set config = jsonb_set(config,
                          '{graph,steps,extract_actions,transcript_field}',
                          '"data.transcript"'::jsonb)
 where config #>> '{graph,steps,extract_actions,transcript_field}' = 'transcript';

update public.workflows
   set draft_config = replace(draft_config::text,
                              '{{steps.meeting_complete.body.meeting_id}}',
                              '{{steps.meeting_complete.body.data.meeting.id}}')::jsonb
 where draft_config is not null
   and position('{{steps.meeting_complete.body.meeting_id}}' in draft_config::text) > 0;

update public.workflows
   set draft_config = replace(draft_config::text,
                              '{{steps.meeting_complete.body.title}}',
                              '{{steps.meeting_complete.body.data.meeting.title}}')::jsonb
 where draft_config is not null
   and position('{{steps.meeting_complete.body.title}}' in draft_config::text) > 0;

update public.workflows
   set draft_config = jsonb_set(draft_config,
                                '{graph,steps,extract_actions,transcript_field}',
                                '"data.transcript"'::jsonb)
 where draft_config is not null
   and draft_config #>> '{graph,steps,extract_actions,transcript_field}' = 'transcript';
