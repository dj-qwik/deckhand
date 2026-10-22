// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title DECKHAND match escrow
/// @notice Holds entry fees for one match at a time per id and pays the pot out
///         90% to the winner / 10% to the treasury once enough independent
///         co-signers have replayed the match and signed the same result.
///         Unfilled, cancelled or abandoned matches refund every entrant in full.
contract DeckhandEscrow {
    // ---------------------------------------------------------------- types
    enum Status {
        None,
        Open,
        Locked,
        Settled,
        Refunded
    }

    struct Match {
        uint128 entry; // wei per seat
        uint64 deadline; // last second deposits are accepted while Open
        uint64 lockedAt; // when the last seat was paid
        uint8 seats; // 2..4
        uint8 joined;
        Status status;
    }

    // ------------------------------------------------------------ constants
    uint256 public constant WINNER_PCT = 90;
    uint64 public constant ADMIN_DELAY = 2 days;
    uint64 public constant MAX_PLAY = 2 hours; // a Locked match older than this is refundable by anyone
    uint64 public constant MAX_JOIN_WINDOW = 1 hours;

    bytes32 public constant RESULT_TYPEHASH = keccak256("Result(bytes32 matchId,address winner,bytes32 resultHash)");
    bytes32 public constant JOIN_TYPEHASH = keccak256("Join(bytes32 matchId,address player,uint64 expiry)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("DeckhandEscrow");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // --------------------------------------------------------------- storage
    mapping(bytes32 => Match) public matches;
    mapping(bytes32 => address[]) private _players;
    mapping(bytes32 => mapping(address => bool)) public joined;
    mapping(address => uint256) public owed; // payouts whose push failed; pull with withdrawOwed()

    address public admin;
    address public pendingAdmin;
    uint64 public pendingAdminAfter;

    address public treasury;
    address public guardian;
    mapping(address => bool) public isOperator;
    mapping(address => bool) public isCosigner;
    address[] private _cosigners;
    uint8 public threshold;
    uint128 public maxEntry;
    bool public paused;

    uint256 private _locked = 1;

    // ---------------------------------------------------------------- events
    event MatchCreated(bytes32 indexed matchId, uint128 entry, uint8 seats, uint64 deadline);
    event Deposited(bytes32 indexed matchId, address indexed player, uint8 seat);
    event MatchLocked(bytes32 indexed matchId);
    event Settled(bytes32 indexed matchId, address indexed winner, uint256 winnerAmount, uint256 houseAmount, bytes32 resultHash);
    event Refunded(bytes32 indexed matchId, uint256 perSeat, uint8 players);
    event PayoutOwed(address indexed to, uint256 amount);
    event OwedWithdrawn(address indexed to, uint256 amount);
    event AdminTransferStarted(address indexed newAdmin, uint64 acceptableAfter);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    event OperatorSet(address indexed operator, bool enabled);
    event CosignersSet(address[] cosigners, uint8 threshold);
    event TreasurySet(address treasury);
    event GuardianSet(address guardian);
    event MaxEntrySet(uint128 maxEntry);
    event Paused(bool paused);

    // ---------------------------------------------------------------- errors
    error NotAuthorized();
    error IsPaused();
    error BadParams();
    error BadStatus();
    error Expired();
    error WrongValue();
    error AlreadyJoined();
    error Full();
    error BadSignature();
    error NotAPlayer();
    error TooEarly();
    error Reentrancy();

    // ------------------------------------------------------------- modifiers
    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAuthorized();
        _;
    }

    modifier onlyOperator() {
        if (!isOperator[msg.sender]) revert NotAuthorized();
        _;
    }

    modifier notPaused() {
        if (paused) revert IsPaused();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ----------------------------------------------------------- constructor
    constructor(
        address operator,
        address[] memory cosigners,
        uint8 threshold_,
        address treasury_,
        address guardian_,
        address futureAdmin,
        uint128 maxEntry_
    ) {
        admin = msg.sender;
        emit AdminTransferred(address(0), msg.sender);
        _setOperator(operator, true);
        _setCosigners(cosigners, threshold_);
        _setTreasury(treasury_);
        _setGuardian(guardian_);
        _setMaxEntry(maxEntry_);
        if (futureAdmin != address(0) && futureAdmin != msg.sender) _startAdminTransfer(futureAdmin);
    }

    // ================================================================ matches

    /// @notice Open a lobby. Only the game server's operator key can do this.
    function createMatch(bytes32 matchId, uint128 entry, uint8 seats, uint64 deadline) external onlyOperator notPaused {
        if (matches[matchId].status != Status.None) revert BadStatus();
        if (seats < 2 || seats > 4) revert BadParams();
        if (entry == 0 || entry > maxEntry) revert BadParams();
        if (deadline <= block.timestamp || deadline > block.timestamp + MAX_JOIN_WINDOW) revert BadParams();
        matches[matchId] = Match({entry: entry, deadline: deadline, lockedAt: 0, seats: seats, joined: 0, status: Status.Open});
        emit MatchCreated(matchId, entry, seats, deadline);
    }

    /// @notice Pay one seat. `permit` is the operator's EIP-712 Join signature for
    ///         (matchId, msg.sender, expiry), so strangers cannot take seats.
    ///         The match locks itself when the last seat is paid.
    function deposit(bytes32 matchId, uint64 expiry, bytes calldata permit) external payable notPaused nonReentrant {
        Match storage m = matches[matchId];
        if (m.status != Status.Open) revert BadStatus();
        if (block.timestamp > m.deadline || block.timestamp > expiry) revert Expired();
        if (msg.value != m.entry) revert WrongValue();
        if (joined[matchId][msg.sender]) revert AlreadyJoined();
        if (m.joined >= m.seats) revert Full();
        bytes32 digest = _hashTyped(keccak256(abi.encode(JOIN_TYPEHASH, matchId, msg.sender, expiry)));
        if (!isOperator[_recover(digest, permit)]) revert BadSignature();

        joined[matchId][msg.sender] = true;
        _players[matchId].push(msg.sender);
        m.joined += 1;
        emit Deposited(matchId, msg.sender, m.joined);
        if (m.joined == m.seats) {
            m.status = Status.Locked;
            m.lockedAt = uint64(block.timestamp);
            emit MatchLocked(matchId);
        }
    }

    /// @notice Pay out a finished match. Needs `threshold` signatures from distinct
    ///         co-signers over Result(matchId, winner, resultHash). Anyone may submit.
    function submitResult(bytes32 matchId, address winner, bytes32 resultHash, bytes[] calldata sigs) external nonReentrant {
        Match storage m = matches[matchId];
        if (m.status != Status.Locked) revert BadStatus();
        if (!joined[matchId][winner]) revert NotAPlayer();
        if (sigs.length < threshold) revert BadSignature();

        bytes32 digest = _hashTyped(keccak256(abi.encode(RESULT_TYPEHASH, matchId, winner, resultHash)));
        address last = address(0);
        uint256 good = 0;
        for (uint256 i = 0; i < sigs.length; i++) {
            address s = _recover(digest, sigs[i]);
            if (uint160(s) <= uint160(last)) revert BadSignature(); // strictly ascending ⇒ distinct
            if (!isCosigner[s]) revert BadSignature();
            last = s;
            good++;
        }
        if (good < threshold) revert BadSignature();

        uint256 pot = uint256(m.entry) * m.joined;
        uint256 winnerAmount = (pot * WINNER_PCT) / 100;
        uint256 houseAmount = pot - winnerAmount;
        m.status = Status.Settled;
        emit Settled(matchId, winner, winnerAmount, houseAmount, resultHash);
        _push(winner, winnerAmount);
        _push(treasury, houseAmount);
    }

    /// @notice Operator or guardian voids a match that is Open or Locked (server crash,
    ///         lobby abandoned). Everyone who paid gets their full entry back.
    function cancel(bytes32 matchId) external nonReentrant {
        if (!isOperator[msg.sender] && msg.sender != guardian && msg.sender != admin) revert NotAuthorized();
        Status s = matches[matchId].status;
        if (s != Status.Open && s != Status.Locked) revert BadStatus();
        _refund(matchId);
    }

    /// @notice Anyone can refund a lobby whose join deadline passed, or a locked match
    ///         that has gone MAX_PLAY without a result.
    function refundExpired(bytes32 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        if (m.status == Status.Open) {
            if (block.timestamp <= m.deadline) revert TooEarly();
        } else if (m.status == Status.Locked) {
            if (block.timestamp <= uint256(m.lockedAt) + MAX_PLAY) revert TooEarly();
        } else {
            revert BadStatus();
        }
        _refund(matchId);
    }

    /// @notice Collect a payout or refund whose direct transfer failed.
    function withdrawOwed() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert BadParams();
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert WrongValue();
        emit OwedWithdrawn(msg.sender, amount);
    }

    // ================================================================== views

    function players(bytes32 matchId) external view returns (address[] memory) {
        return _players[matchId];
    }

    function cosigners() external view returns (address[] memory) {
        return _cosigners;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function resultDigest(bytes32 matchId, address winner, bytes32 resultHash) external view returns (bytes32) {
        return _hashTyped(keccak256(abi.encode(RESULT_TYPEHASH, matchId, winner, resultHash)));
    }

    function joinDigest(bytes32 matchId, address player, uint64 expiry) external view returns (bytes32) {
        return _hashTyped(keccak256(abi.encode(JOIN_TYPEHASH, matchId, player, expiry)));
    }

    // ================================================================== admin

    function setOperator(address operator, bool enabled) external onlyAdmin {
        _setOperator(operator, enabled);
    }

    function setCosigners(address[] calldata list, uint8 threshold_) external onlyAdmin {
        _setCosigners(list, threshold_);
    }

    function setTreasury(address t) external onlyAdmin {
        _setTreasury(t);
    }

    function setGuardian(address g) external onlyAdmin {
        _setGuardian(g);
    }

    function setMaxEntry(uint128 v) external onlyAdmin {
        _setMaxEntry(v);
    }

    function setPaused(bool p) external {
        if (msg.sender != admin && msg.sender != guardian) revert NotAuthorized();
        paused = p;
        emit Paused(p);
    }

    /// @notice Start handing admin to `newAdmin`; they can accept after ADMIN_DELAY.
    function beginDefaultAdminTransfer(address newAdmin) external onlyAdmin {
        _startAdminTransfer(newAdmin);
    }

    function cancelDefaultAdminTransfer() external onlyAdmin {
        pendingAdmin = address(0);
        pendingAdminAfter = 0;
        emit AdminTransferStarted(address(0), 0);
    }

    function acceptDefaultAdminTransfer() external {
        if (msg.sender != pendingAdmin) revert NotAuthorized();
        if (block.timestamp < pendingAdminAfter) revert TooEarly();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
        pendingAdminAfter = 0;
    }

    // =============================================================== internal

    function _refund(bytes32 matchId) private {
        Match storage m = matches[matchId];
        m.status = Status.Refunded;
        address[] storage ps = _players[matchId];
        emit Refunded(matchId, m.entry, uint8(ps.length));
        for (uint256 i = 0; i < ps.length; i++) _push(ps[i], m.entry);
    }

    function _push(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount, gas: 50_000}("");
        if (!ok) {
            owed[to] += amount;
            emit PayoutOwed(to, amount);
        }
    }

    function _hashTyped(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert BadSignature();
        if (uint256(s) > HALF_N) revert BadSignature();
        address a = ecrecover(digest, v, r, s);
        if (a == address(0)) revert BadSignature();
        return a;
    }

    function _setOperator(address operator, bool enabled) private {
        if (operator == address(0)) revert BadParams();
        isOperator[operator] = enabled;
        emit OperatorSet(operator, enabled);
    }

    function _setCosigners(address[] memory list, uint8 threshold_) private {
        if (threshold_ < 1 || threshold_ > list.length) revert BadParams();
        for (uint256 i = 0; i < _cosigners.length; i++) isCosigner[_cosigners[i]] = false;
        delete _cosigners;
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == address(0) || isCosigner[list[i]]) revert BadParams();
            isCosigner[list[i]] = true;
            _cosigners.push(list[i]);
        }
        threshold = threshold_;
        emit CosignersSet(list, threshold_);
    }

    function _setTreasury(address t) private {
        if (t == address(0)) revert BadParams();
        treasury = t;
        emit TreasurySet(t);
    }

    function _setGuardian(address g) private {
        if (g == address(0)) revert BadParams();
        guardian = g;
        emit GuardianSet(g);
    }

    function _setMaxEntry(uint128 v) private {
        if (v == 0) revert BadParams();
        maxEntry = v;
        emit MaxEntrySet(v);
    }

    function _startAdminTransfer(address newAdmin) private {
        if (newAdmin == address(0)) revert BadParams();
        pendingAdmin = newAdmin;
        pendingAdminAfter = uint64(block.timestamp) + ADMIN_DELAY;
        emit AdminTransferStarted(newAdmin, pendingAdminAfter);
    }
}
