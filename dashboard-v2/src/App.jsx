import { useState, useEffect, Component } from "react";
import { useBotOrders } from "./hooks/useBotOrders";
import { useMarketPrices } from "./hooks/useMarketPrices";
import PriceChart from "./components/PriceChart";
import OrderBookPanel from "./components/OrderBookPanel";
import ActivityFeed from "./components/ActivityFeed";
import PositionSummary from "./components/PositionSummary";
import MarketStats from "./components/MarketStats";
import LogPanel from "./components/LogPanel";

// Error Boundary component
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Dashboard Error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gray-900 text-white p-8">
          <h1 className="text-2xl text-red-500 mb-4">Something went wrong</h1>
          <pre className="bg-gray-800 p-4 rounded overflow-auto text-sm">
            {this.state.error?.toString()}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function Dashboard() {
  const {
    orders,
    activities,
    position,
    surgeLine,
    hedgeLine,
    logs,
    connected: relayConnected,
    botConnected,
  } = useBotOrders();
  const {
    prices,
    priceHistory,
    market,
    connected: priceConnected,
  } = useMarketPrices();

  // Calculate time remaining
  const [timeRemaining, setTimeRemaining] = useState("--:--");

  useEffect(() => {
    if (!market?.endTime) return;

    const updateTimer = () => {
      const now = Math.floor(Date.now() / 1000);
      const remaining = market.endTime - now;

      if (remaining <= 0) {
        setTimeRemaining("00:00");
      } else {
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        setTimeRemaining(
          `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`,
        );
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [market?.endTime]);

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4">
      {/* Header */}
      <header className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold">Dashboard V2</h1>
          <span className="text-gray-400 text-sm">
            {market?.slug || "Loading..."}
          </span>
        </div>

        <div className="flex items-center gap-4">
          {/* Connection Status */}
          <div className="flex items-center gap-2 text-sm">
            <span className="text-gray-400">Bot:</span>
            <span
              className={`w-2 h-2 rounded-full ${botConnected ? "bg-green-500" : "bg-red-500"}`}
              title={
                botConnected
                  ? "Trading bot connected"
                  : "No trading bot connected"
              }
            />
            <span
              className={`text-xs ${botConnected ? "text-green-400" : "text-red-400"}`}
            >
              {botConnected ? "connected" : "disconnected"}
            </span>
            <span className="text-gray-400 ml-2">Prices:</span>
            <span
              className={`w-2 h-2 rounded-full ${priceConnected ? "bg-green-500" : "bg-red-500"}`}
              title={
                priceConnected
                  ? "Price feed connected"
                  : "Price feed disconnected"
              }
            />
          </div>

          {/* Timer */}
          <div className="bg-gray-800 px-4 py-2 rounded-lg">
            <span className="text-gray-400 text-sm mr-2">Time:</span>
            <span className="font-mono text-lg">{timeRemaining}</span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="grid grid-cols-12 gap-4">
        {/* Left Column - Chart + Logs */}
        <div className="col-span-9 flex flex-col gap-4">
          <div className="bg-gray-800 rounded-lg p-4 h-[500px]">
            <PriceChart
              priceHistory={priceHistory}
              orders={orders}
              prices={prices}
              market={market}
              surgeLine={surgeLine}
              hedgeLine={hedgeLine}
            />
          </div>

          {/* Logs Panel - below chart */}
          <div className="bg-gray-800 rounded-lg p-4 h-[250px]">
            <LogPanel logs={logs} />
          </div>
        </div>

        {/* Right Column - Panels */}
        <div className="col-span-3 flex flex-col gap-4">
          {/* Market Stats */}
          <div className="bg-gray-800 rounded-lg p-4">
            <MarketStats
              prices={prices}
              market={market}
              timeRemaining={timeRemaining}
            />
          </div>

          {/* Position Summary */}
          <div className="bg-gray-800 rounded-lg p-4">
            <PositionSummary position={position} prices={prices} />
          </div>

          {/* Order Book - Pending Orders */}
          <div className="bg-gray-800 rounded-lg p-4 max-h-[200px] overflow-auto">
            <OrderBookPanel orders={orders} />
          </div>

          {/* Activity Feed - Order History */}
          <div className="bg-gray-800 rounded-lg p-4 flex-1 overflow-auto max-h-[300px]">
            <ActivityFeed activities={activities} />
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <Dashboard />
    </ErrorBoundary>
  );
}

export default App;
