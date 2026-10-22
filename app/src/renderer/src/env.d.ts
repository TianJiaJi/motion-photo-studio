/// <reference types="vite/client" />
import type { DesktopAPI } from '../../shared/contracts.ts';
declare global { interface Window { motion: DesktopAPI } }
