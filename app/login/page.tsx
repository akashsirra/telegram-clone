"use client";

import { useState } from "react";

export default function LoginPage() {
  const [isSignup, setIsSignup] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    // Add your Supabase / Firebase / Auth logic here
    console.log("Submitting:", { email, password, rememberMe, isSignup });

    // Simulating API request delay
    setTimeout(() => {
      setLoading(false);
    }, 1500);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-900 text-white p-4">
      <div className="w-full max-w-md p-8 space-y-6 bg-gray-800 rounded-xl shadow-lg border border-gray-700">
        <h2 className="text-2xl font-bold text-center">
          {isSignup ? "Create an Account" : "Welcome Back"}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="••••••••"
            />
          </div>

          {/* Remember Me option — visible only on Login */}
          {!isSignup && (
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-blue-600 focus:ring-blue-500 cursor-pointer"
                />
                Remember me
              </label>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 font-semibold rounded-lg transition duration-200 disabled:opacity-50"
          >
            {loading
              ? "Please wait..."
              : isSignup
              ? "Sign Up"
              : "Log In"}
          </button>
        </form>

        <div className="text-center pt-2">
          <button
            type="button"
            onClick={() => setIsSignup(!isSignup)}
            className="w-full text-center text-blue-400 text-sm hover:underline"
          >
            {isSignup
              ? "Already have an account? Log in"
              : "New here? Sign up"}
          </button>
        </div>
      </div>
    </div>
  );
}