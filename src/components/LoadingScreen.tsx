import React, { useEffect } from 'react';
import { motion } from 'motion/react';
import AppIcon from './AppIcon';

// A brief launch moment, not a wait: long enough to register, short enough to
// never stand between the user and the app.
const SPLASH_MS = 900;

export default function LoadingScreen({ onComplete }: { onComplete: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onComplete, SPLASH_MS);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35, ease: [0.28, 0.11, 0.32, 1] }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-canvas"
      aria-hidden="true"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.28, 0.11, 0.32, 1] }}
        className="flex flex-col items-center gap-5"
      >
        <AppIcon size={72} />
        <div className="text-center">
          <p className="text-2xl font-semibold tracking-tight text-label">Data Science Studio</p>
          <p className="text-sm text-label-2 mt-1">by AskDeepakAI</p>
        </div>
      </motion.div>
    </motion.div>
  );
}
