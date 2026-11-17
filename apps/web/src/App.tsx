import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import type { PermissionKey } from '@jobflow/shared';
import { useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { LoadingState, PermissionDenied } from './components/states';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { UsersPage } from './pages/admin/UsersPage';
import { UserDetailPage } from './pages/admin/UserDetailPage';
import { DepartmentsPage } from './pages/admin/DepartmentsPage';
import { RolesPage } from './pages/admin/RolesPage';
import { RoleDetailPage } from './pages/admin/RoleDetailPage';
import { AuditPage } from './pages/admin/AuditPage';
import { TemplatesPage } from './pages/admin/TemplatesPage';
import { TemplateVersionPage } from './pages/admin/TemplateVersionPage';
import { SettingsPage } from './pages/admin/SettingsPage';
import { JobsPage } from './pages/jobs/JobsPage';
import { NewJobPage } from './pages/jobs/NewJobPage';
import { JobPage } from './pages/jobs/JobPage';
import { MyWorkPage } from './pages/MyWorkPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { ReportsPage } from './pages/ReportsPage';
import { SystemPage } from './pages/admin/SystemPage';

const PASSWORD_PATH = '/account/password';

function RequireAuth() {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingState label="Starting JobFlow…" />;
  if (!me) return <Navigate to="/login" replace />;
  if (me.user.mustChangePassword && location.pathname !== PASSWORD_PATH) return <Navigate to={PASSWORD_PATH} replace />;
  return <Outlet />;
}

/** UI convenience only; the API enforces the same permission on every call. */
function RequirePermission({ permission }: { permission: PermissionKey }) {
  const { can } = useAuth();
  return can(permission) ? <Outlet /> : <PermissionDenied />;
}

export const routes = [
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <HomePage /> },
          { path: PASSWORD_PATH, element: <ChangePasswordPage /> },
          { path: '/my-work', element: <MyWorkPage /> },
          { path: '/notifications', element: <NotificationsPage /> },
          {
            element: <RequirePermission permission="job.view" />,
            children: [
              { path: '/jobs', element: <JobsPage /> },
              { path: '/jobs/:id', element: <JobPage /> },
            ],
          },
          { element: <RequirePermission permission="report.view" />, children: [{ path: '/reports', element: <ReportsPage /> }] },
          { element: <RequirePermission permission="job.create" />, children: [{ path: '/jobs/new', element: <NewJobPage /> }] },
          {
            element: <RequirePermission permission="template.manage" />,
            children: [
              { path: '/admin/templates', element: <TemplatesPage /> },
              { path: '/admin/templates/versions/:id', element: <TemplateVersionPage /> },
            ],
          },
          { element: <RequirePermission permission="settings.manage" />, children: [{ path: '/admin/settings', element: <SettingsPage /> }] },
          {
            element: <RequirePermission permission="user.manage" />,
            children: [
              { path: '/admin/users', element: <UsersPage /> },
              { path: '/admin/users/:id', element: <UserDetailPage /> },
            ],
          },
          { element: <RequirePermission permission="department.manage" />, children: [{ path: '/admin/departments', element: <DepartmentsPage /> }] },
          {
            element: <RequirePermission permission="role.manage" />,
            children: [
              { path: '/admin/roles', element: <RolesPage /> },
              { path: '/admin/roles/:id', element: <RoleDetailPage /> },
            ],
          },
          { element: <RequirePermission permission="outbox.manage" />, children: [{ path: '/admin/system', element: <SystemPage /> }] },
          { element: <RequirePermission permission="audit.view" />, children: [{ path: '/admin/audit', element: <AuditPage /> }] },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
];

const router = createBrowserRouter(routes);

export function App() {
  return <RouterProvider router={router} />;
}
