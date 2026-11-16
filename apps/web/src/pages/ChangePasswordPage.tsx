import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Button, Paper, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { PASSWORD_MIN_LENGTH } from '@jobflow/shared';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../components/states';

export function ChangePasswordPage() {
  const { me, changePassword } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const forced = me?.user.mustChangePassword ?? false;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < PASSWORD_MIN_LENGTH) return setError(`New password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    if (next !== repeat) return setError('The new passwords do not match');
    setBusy(true);
    try {
      await changePassword({ currentPassword: current, newPassword: next });
      notifications.show({ color: 'green', message: 'Password changed. Other devices have been signed out.' });
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Paper withBorder p="xl" maw={460}>
      <form onSubmit={submit}>
        <Stack>
          <Title order={3}>Change password</Title>
          {forced && (
            <Alert color="yellow">
              Your password was set by an administrator. Choose a new password to continue.
            </Alert>
          )}
          {error && (
            <Alert color="red" role="alert">
              {error}
            </Alert>
          )}
          <PasswordInput label="Current password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.currentTarget.value)} />
          <PasswordInput
            label="New password"
            description={`At least ${PASSWORD_MIN_LENGTH} characters`}
            autoComplete="new-password"
            required
            value={next}
            onChange={(e) => setNext(e.currentTarget.value)}
          />
          <PasswordInput label="Repeat new password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.currentTarget.value)} />
          <Button type="submit" loading={busy}>
            Change password
          </Button>
          <Text size="xs" c="dimmed">
            Changing your password signs you out on every other device.
          </Text>
        </Stack>
      </form>
    </Paper>
  );
}
