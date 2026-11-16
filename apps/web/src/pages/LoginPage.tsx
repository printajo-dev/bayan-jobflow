import { useState } from 'react';
import { Navigate } from 'react-router';
import { Alert, Button, Center, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../components/states';

export function LoginPage() {
  const { me, login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me) return <Navigate to="/" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login({ username, password });
    } catch (err) {
      setError(errorMessage(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Center mih="100vh" bg="gray.0" p="md">
      <Paper withBorder shadow="sm" p="xl" radius="md" w={380}>
        <form onSubmit={submit}>
          <Stack>
            <div>
              <Title order={2}>Bayan JobFlow</Title>
              <Text c="dimmed" size="sm">
                Sign in with your office account
              </Text>
            </div>
            {error && (
              <Alert color="red" role="alert">
                {error}
              </Alert>
            )}
            <TextInput
              label="Username"
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
            />
            <PasswordInput
              label="Password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
            <Button type="submit" loading={busy} fullWidth>
              Sign in
            </Button>
            <Text size="xs" c="dimmed">
              Forgotten your password? Ask a system administrator to reset it.
            </Text>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
