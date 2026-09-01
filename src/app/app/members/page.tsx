import { MoreHorizontal, Plus, ShieldCheck } from "lucide-react";

const people = [["Alex Dubey", "alex@acme.co", "Owner", "AD"], ["Maya Singh", "maya@acme.co", "Admin", "MS"], ["Noah Williams", "noah@acme.co", "Member", "NW"], ["Iris Chen", "iris@acme.co", "Viewer", "IC"]];

export default function MembersPage() {
  return <main className="app-page list-page"><header className="page-title-row"><div><span className="page-kicker">Workspace access</span><h1>Members</h1><p>Invite people and control what they can change.</p></div><button className="button button-primary"><Plus size={16} />Invite member</button></header><section className="panel member-list"><header><span>Member</span><span>Role</span><span>Joined</span><span /></header>{people.map(([name, email, role, initials], index) => <div key={email}><i>{initials}</i><span><b>{name}</b><small>{email}</small></span><em><ShieldCheck size={12} />{role}</em><small>{index === 0 ? "31 Aug 2026" : "28 Aug 2026"}</small><button><MoreHorizontal size={16} /></button></div>)}</section></main>;
}
