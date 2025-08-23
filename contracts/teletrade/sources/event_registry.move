module teletrade::event_registry {
    use std::signer;
    use aptos_framework::event;

    const E_NOT_AUTH: u64 = 300;

    fun assert_admin(s: &signer) {
        assert!(signer::address_of(s) == @teletrade, E_NOT_AUTH);
    }

    #[event]
    struct OrderRouted has drop, store {
        user: address,
        venue: vector<u8>,     // e.g., b"merkel"
        client_id: vector<u8>, // client nonce/ULID
    }

    #[event]
    struct TradeExecuted has drop, store {
        user: address,
        venue: vector<u8>,
        fill_sz: u128,
        price: u128,
        pnl_abs: u128,      // absolute PnL value
        pnl_negative: bool, // true = loss, false = profit/zero
        ts: u64,
    }

    public entry fun emit_order_routed(
        admin: &signer,
        user: address,
        venue: vector<u8>,
        client_id: vector<u8>,
    ) {
        assert_admin(admin);
        event::emit<OrderRouted>(OrderRouted { user, venue, client_id });
    }

    public entry fun emit_trade_executed(
        admin: &signer,
        user: address,
        venue: vector<u8>,
        fill_sz: u128,
        price: u128,
        pnl_abs: u128,
        pnl_negative: bool,
        ts: u64,
    ) {
        assert_admin(admin);
        event::emit<TradeExecuted>(TradeExecuted { user, venue, fill_sz, price, pnl_abs, pnl_negative, ts });
    }
}

