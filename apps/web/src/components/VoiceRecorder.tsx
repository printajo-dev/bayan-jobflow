import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, Text } from '@mantine/core';
import { MAX_VOICE_SECONDS } from '@jobflow/shared';

export interface VoiceClip {
  blob: Blob;
  durationSec: number;
  filename: string;
}

type State = 'idle' | 'recording' | 'paused' | 'stopped';

function pickMime(): { mime: string; ext: string } {
  const options = [
    { mime: 'audio/webm;codecs=opus', ext: 'webm' },
    { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
    { mime: 'audio/mp4', ext: 'm4a' },
  ];
  for (const o of options) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(o.mime)) return o;
  return { mime: '', ext: 'webm' };
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Records a voice note in the browser (needs HTTPS and microphone
 * permission). Record → pause/resume → stop → preview → re-record or use.
 */
export function VoiceRecorder({ onReady, onCancel }: { onReady: (clip: VoiceClip) => void; onCancel: () => void }) {
  const [state, setState] = useState<State>('idle');
  const [seconds, setSeconds] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const clip = useRef<VoiceClip | null>(null);
  const timer = useRef<number | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const secondsRef = useRef(0);

  const stopTracks = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  const stopTimer = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      stopTimer();
      stopTracks();
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  async function start() {
    setError(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError('Voice recording needs the secure (https) JobFlow address and a browser that supports recording.');
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('Microphone permission was refused. Allow the microphone for this site and try again.');
      return;
    }
    const { mime, ext } = pickMime();
    const rec = new MediaRecorder(stream.current, mime ? { mimeType: mime, audioBitsPerSecond: 32_000 } : undefined);
    chunks.current = [];
    rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    rec.onstop = () => {
      stopTracks();
      const blob = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' });
      const u = URL.createObjectURL(blob);
      setUrl(u);
      clip.current = { blob, durationSec: secondsRef.current, filename: `voice-note.${ext}` };
      setState('stopped');
    };
    recorder.current = rec;
    rec.start(1000);
    setSeconds(0);
    secondsRef.current = 0;
    setState('recording');
    timer.current = window.setInterval(() => {
      if (recorder.current?.state !== 'recording') return;
      secondsRef.current += 1;
      setSeconds(secondsRef.current);
      if (secondsRef.current >= MAX_VOICE_SECONDS) stop();
    }, 1000);
  }
  function pause() {
    recorder.current?.pause();
    setState('paused');
  }
  function resume() {
    recorder.current?.resume();
    setState('recording');
  }
  function stop() {
    stopTimer();
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
  }
  function reset() {
    if (url) URL.revokeObjectURL(url);
    setUrl(null);
    clip.current = null;
    setSeconds(0);
    setState('idle');
  }

  return (
    <div>
      {error && (
        <Alert color="red" mb="xs">
          {error}
        </Alert>
      )}
      <Group gap="xs">
        {state === 'idle' && (
          <Button size="xs" color="red" onClick={() => void start()}>
            ● Record
          </Button>
        )}
        {state === 'recording' && (
          <>
            <Text size="sm" c="red" fw={600}>
              ● {fmt(seconds)}
            </Text>
            <Button size="xs" variant="default" onClick={pause}>
              Pause
            </Button>
            <Button size="xs" onClick={stop}>
              Stop
            </Button>
          </>
        )}
        {state === 'paused' && (
          <>
            <Text size="sm">Paused at {fmt(seconds)}</Text>
            <Button size="xs" variant="default" onClick={resume}>
              Resume
            </Button>
            <Button size="xs" onClick={stop}>
              Stop
            </Button>
          </>
        )}
        {state === 'stopped' && url && (
          <>
            <audio controls src={url} style={{ height: 32 }} aria-label="Preview voice note" />
            <Button size="xs" variant="default" onClick={reset}>
              Re-record
            </Button>
            <Button size="xs" onClick={() => clip.current && onReady(clip.current)}>
              Use this recording
            </Button>
          </>
        )}
        <Button size="xs" variant="subtle" color="gray" onClick={() => { stop(); reset(); onCancel(); }}>
          Cancel
        </Button>
      </Group>
      <Text size="xs" c="dimmed" mt={4}>
        Up to {MAX_VOICE_SECONDS / 60} minutes.
      </Text>
    </div>
  );
}
