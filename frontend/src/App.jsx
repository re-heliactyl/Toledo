import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { AlertTriangle, RefreshCw, Info } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";

import MainLayout from '@/components/layouts/MainLayout';
import Overview from '@/pages/server/Overview';
import FileManagerPage from './pages/server/FileManagerPage';
import PluginManagerPage from './pages/server/PluginManagerPage';
import Network from './pages/server/Network';
import UserManagerPage from './pages/server/UserManagerPage'
import Players from './pages/server/Players';
import Backups from './pages/server/Backups';
import Settings from './pages/server/Settings';
import Package from './pages/server/Package';
import Logs from './pages/server/Logs';

import Website from './pages/Website';

import Dashboard from './pages/Dashboard';
import Auth from './pages/Auth';
import TwoFactorVerification from './pages/TwoFactorVerification';
import NotFound from './pages/NotFound';
import Boosts from './pages/Boosts';

import AFKPage from './pages/coins/AFKPage';
import Store from './pages/coins/Store';
import Staking from './pages/coins/Staking';
import Daily from './pages/coins/Daily';
import AccountPage from './pages/Account';
import PasskeyManager from './pages/Passkeys';

import AdminOverview from './pages/admin/Overview';
import AdminUsers from './pages/admin/Users';
import AdminNodes from './pages/admin/Nodes';
import AdminTickets from './pages/admin/Tickets';
import AdminRadar from './pages/admin/Radar';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      countdown: 15
    };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      error: error
    };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Error caught by boundary:', error, errorInfo);
  }

  componentDidUpdate(prevProps, prevState) {
    if (this.state.hasError && !prevState.hasError) {
      this.startCountdown();
    }
  }

  startCountdown = () => {
    this.countdownInterval = setInterval(() => {
      this.setState(state => ({
        countdown: state.countdown - 1
      }), () => {
        if (this.state.countdown === 0) {
          clearInterval(this.countdownInterval);
          window.location.reload();
        }
      });
    }, 1000);
  }

  componentWillUnmount() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
  }

  handleRefreshNow = () => {
    window.location.reload();
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-destructive" />
                <CardTitle>Something went wrong with Heliactyl Next 10</CardTitle>
              </div>
              <CardDescription>
                An error occurred while rendering the page.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-muted/50 rounded-lg p-4 text-sm font-mono overflow-auto max-h-[200px]">
                {this.state.error?.message || 'Unknown error'}
              </div>

              <Accordion type="single" collapsible className="w-full">
                <AccordionItem value="system-info">
                  <AccordionTrigger className="text-sm">
                    <div className="flex items-center gap-2">
                      <Info className="h-4 w-4" />
                      System information
                    </div>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-2 text-sm text-muted-foreground">
                      <p>Version: Heliactyl Next 10.x.x</p>
                      <p>Codename: Toledo</p>
                      <p>Platform: 305</p>
                      <p>User Agent: {navigator.userAgent}</p>
                      <p>Timestamp: {new Date().toISOString()}</p>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>

              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Refreshing in {this.state.countdown}...
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={this.handleRefreshNow}
                  className="gap-2"
                >
                  <RefreshCw className="h-4 w-4" />
                  Refresh Now
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}

// Root redirect component that checks the origin and routes accordingly
const RootRedirect = () => {
  // Get the current hostname
  const hostname = window.location.hostname;

  // Check if it's the console subdomain
  if (hostname === 'console.altare.pro') {
    return <Navigate to="/dashboard" replace />;
  }

  // If it's the main domain or www subdomain, show the website
  if (hostname === 'altare.pro' || hostname === 'www.altare.pro') {
    return <Website />;
  }

  // Default to dashboard for any other domain/subdomain
  return <Navigate to="/dashboard" replace />;
};

// Protected Route
const ProtectedRoute = ({ children }) => {
  const [isChecking, setIsChecking] = useState(true);
  const [requires2FA, setRequires2FA] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await fetch('/api/v5/state', {
          credentials: 'include',
        });

        if (!response.ok) {
          throw new Error('Unauthorized');
        }

        const data = await response.json();
        if (data.twoFactorPending) {
          setRequires2FA(true);
          navigate('/auth/2fa', {
            state: {
              redirectUrl: window.location.pathname
            }
          });
          return;
        }

        setIsChecking(false);
      } catch (error) {
        console.error('Auth check failed:', error);
        window.location.href = '/auth';
      }
    };

    checkAuth();
  }, [navigate]);

  if (isChecking) {
    return (
      <div className="min-h-screen bg-[#101218] flex items-center justify-center p-4">
        <RefreshCw className="w-8 h-8 animate-spin text-[#95a1ad]" />
      </div>
    );
  }

  if (requires2FA) {
    return null; // Will redirect to 2FA page
  }

  return children;
};

export default function App() {
  // Get hostname to determine if we need to render the console or website
  const [isWebsite, setIsWebsite] = useState(false);

  useEffect(() => {
    const hostname = window.location.hostname;
    setIsWebsite(hostname === 'altare.pro' || hostname === 'www.altare.pro');
  }, []);

  // If it's the main website domain, render the Website component directly
  if (isWebsite) {
    return (
      <ErrorBoundary>
        <div className="dark text-white">
          <Website />
        </div>
      </ErrorBoundary>
    );
  }

  // Otherwise render the console application
  return (
    <ErrorBoundary>
      <div className="dark text-white bg-[#151719]">
        <Routes>
          {/* Root route with conditional redirect */}
          <Route path="/" element={<RootRedirect />} />

          {/* Auth routes */}
          <Route path="/auth" element={<Auth />} />
          <Route path="/auth/2fa" element={<TwoFactorVerification />} />

          {/* Protected routes with MainLayout */}
          <Route
            element={
              <ProtectedRoute>
                <MainLayout />
              </ProtectedRoute>
            }
          >
            {/* Server routes */}
            <Route path="/server/:id/overview" element={<Overview />} />
            <Route path="/server/:id/files" element={<FileManagerPage />} />
            <Route path="/server/:id/plugins" element={<PluginManagerPage />} />
            <Route path="/server/:id/network" element={<Network />} />
            <Route path="/server/:id/users" element={<UserManagerPage />} />
            <Route path="/server/:id/players" element={<Players />} />
            <Route path="/server/:id/backups" element={<Backups />} />
            <Route path="/server/:id/settings" element={<Settings />} />
            <Route path="/server/:id/package" element={<Package />} />
            <Route path="/server/:id/logs" element={<Logs />} />

            {/* Dashboard routes */}
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/coins/afk" element={<AFKPage />} />
            <Route path="/coins/store" element={<Store />} />
            <Route path="/coins/staking" element={<Staking />} />
            <Route path="/coins/daily" element={<Daily />} />

            <Route path="/account" element={<AccountPage />} />
            <Route path="/passkeys" element={<PasskeyManager />} />

            {/* Others */}
            <Route path="/boosts" element={<Boosts />} />

            {/* Admin routes */}
            <Route path="/admin/overview" element={<AdminOverview />} />
            <Route path="/admin/users" element={<AdminUsers />} />
            <Route path="/admin/nodes" element={<AdminNodes />} />
            <Route path="/admin/tickets" element={<AdminTickets />} />
            <Route path="/admin/radar" element={<AdminRadar />} />
          </Route>

          {/* 404 catch-all route */}
          <Route path="*" element={<NotFound />} />
          <Route path="/website" element={<Website />} />
        </Routes>
      </div>
    </ErrorBoundary>
  );
}