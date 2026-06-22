import { NavLink, Outlet, useNavigate } from 'react-router-dom'

const NAVY = '#0E2841'

const FOLDERS = [
  { label: 'Inbox',   to: '/mail/inbox',   icon: 'inbox' },
  { label: 'Sent',    to: '/mail/sent',    icon: 'send' },
  { label: 'Compose', to: '/mail/compose', icon: 'edit_square' },
  { label: 'Health',  to: '/admin/mail',   icon: 'mark_email_read', admin: true },
]

export default function MailLayout() {
  const navigate = useNavigate()
  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar */}
      <aside className="w-[200px] flex-shrink-0 border-r flex flex-col py-4"
        style={{ borderColor: 'rgba(15,23,42,0.08)', background: '#FAFAFA' }}>
        <div className="px-4 mb-4">
          <button
            onClick={() => navigate('/mail/compose')}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-[13px] font-semibold text-white"
            style={{ background: NAVY }}>
            <span className="material-symbols-rounded text-[16px]">edit_square</span>
            Compose
          </button>
        </div>
        <nav className="space-y-0.5 px-2 flex-1">
          {FOLDERS.filter(f => !f.admin).map(f => (
            <NavLink key={f.to} to={f.to}>
              {({ isActive }) => (
                <span className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium cursor-pointer transition-colors ${isActive ? 'text-slate-900' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'}`}
                  style={{ background: isActive ? 'rgba(14,40,65,0.07)' : undefined }}>
                  <span className="material-symbols-rounded text-[16px]"
                    style={{ color: isActive ? NAVY : undefined }}>{f.icon}</span>
                  {f.label}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="px-2 pt-2 border-t" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <NavLink to="/admin/mail">
            {({ isActive }) => (
              <span className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12px] cursor-pointer transition-colors ${isActive ? 'text-slate-900' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'}`}>
                <span className="material-symbols-rounded text-[15px]">mark_email_read</span>
                Mail Health
              </span>
            )}
          </NavLink>
        </div>
      </aside>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  )
}
