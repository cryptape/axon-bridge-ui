import React, { useEffect, useMemo, useState } from "react";
import { LoadingOutlined, CopyOutlined } from "@ant-design/icons";
import { BI } from "@ckb-lumos/lumos";
import { ReactComponent as CopyIcon } from "../assets/copy.svg";
import { Placeholder } from "../components/Placeholder";
import {notification, Form, Input, Tooltip, message} from "antd";
import styled from "styled-components";
import { useLightGodwoken } from "../hooks/useLightGodwoken";
import CKBInputPanel from "../components/Input/CKBInputPanel";
import CurrencyInputPanel from "../components/Input/CurrencyInputPanel";
import { useSUDTBalance } from "../hooks/useSUDTBalance";
import { useL1CKBBalance } from "../hooks/useL1CKBBalance";
import { useL2CKBBalance } from "../hooks/useL2CKBBalance";
import { DepositEventEmitter, SUDT, Token } from "../light-godwoken/lightGodwokenType";
import {
  ConfirmModal,
  Card,
  PlusIconContainer,
  PrimaryButton,
  Text,
  CardHeader,
  MainText,
  InputInfo,
  LoadingWrapper,
  Tips,
} from "../style/common";
import { ReactComponent as PlusIcon } from "./../assets/plus.svg";
import { BridgeWalletInfo } from "../components/BridgeWalletInfo";
import { BridgeFeeShow } from "../components/BridgeFeeShow";
import { getDepositInputError, isDepositCKBInputValidate, isSudtInputValidate } from "../utils/inputValidate";
import { formatToThousands, parseStringToBI } from "../utils/numberFormat";
import { ReactComponent as CKBIcon } from "../assets/ckb.svg";
import { WalletConnect } from "../components/WalletConnect";
import { DepositList } from "../components/Deposit/List";
import {
  DepositRejectedError,
  LightGodwokenError,
  NotEnoughCapacityError,
  NotEnoughSudtError,
  TransactionSignError,
} from "../light-godwoken/constants/error";
import { getFullDisplayAmount } from "../utils/formatTokenAmount";
import { captureException } from "@sentry/react";
import EventEmitter from "events";
import { useQuery } from "react-query";
import { useGodwokenVersion } from "../hooks/useGodwokenVersion";
import { useDepositHistory } from "../hooks/useDepositTxHistory";
import { format } from "date-fns";
import copy from "copy-to-clipboard";

const ModalContent = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
`;

export default function CkbToAxon() {
  const [CKBInput, setCKBInput] = useState("");
  const [sudtInput, setSudtInputValue] = useState("");
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isCKBValueValidate, setIsCKBValueValidate] = useState(true);
  const [isSudtValueValidate, setIsSudtValueValidate] = useState(true);
  const [selectedSudt, setSelectedSudt] = useState<SUDT>();
  const [selectedSudtBalance, setSelectedSudtBalance] = useState<string>();
  const lightGodwoken = useLightGodwoken();
  const sudtBalanceQUery = useSUDTBalance();
  const CKBBalanceQuery = useL1CKBBalance();
  const CKBBalance = CKBBalanceQuery.data;
  const { data: l2CKBBalance } = useL2CKBBalance();

  const maxAmount = CKBBalance ? BI.from(CKBBalance).toString() : undefined;
  const cancelTimeout = lightGodwoken?.getCancelTimeout() || 0;
  const tokenList: SUDT[] | undefined = lightGodwoken?.getBuiltinSUDTList();
  const ckbAddress = lightGodwoken?.provider.getL1Address();
  const ethAddress = lightGodwoken?.provider.getL2Address();
  const godwokenVersion = useGodwokenVersion();

  const truncateMiddle = (str: string, first = 40, last = 6): string => {
    return str.substring(0, first) + "..." + str.substring(str.length - last);
  };
  const copyAddress = () => {
    copy(ethAddress || "");
    message.success("copied eth address to clipboard");
  };

  const { txHistory: depositHistory, addTxToHistory, updateTxWithStatus } = useDepositHistory();

  const [depositListListener, setDepositListListener] = useState(new EventEmitter() as DepositEventEmitter);

  const depositListQuery = useQuery(
    ["queryDepositList", { version: lightGodwoken?.getVersion(), l2Address: lightGodwoken?.provider.getL2Address() }],
    () => {
      return lightGodwoken?.getDepositList();
    },
  );

  const { data: depositList, isLoading: depositListLoading } = depositListQuery;

  // apend rpc fetched deposit list to local storage
  depositList?.forEach((deposit) => {
    if (!depositHistory.find((history) => deposit.rawCell.out_point?.tx_hash === history.txHash)) {
      addTxToHistory({
        capacity: deposit.capacity.toHexString(),
        amount: deposit.amount.toHexString(),
        token: deposit.sudt,
        txHash: deposit.rawCell.out_point?.tx_hash || "",
        status: "pending",
        date: format(new Date(), "yyyy-MM-dd HH:mm:ss"),
        cancelTimeout,
      });
    }
  });

  const depositHistoryFilteredByCancelTimeout = depositHistory.filter(
    (history) => history.cancelTimeout === cancelTimeout,
  );

  useMemo(() => {
    const pendingList = depositHistory.filter((history) => history.status === "pending");
    const subscribePayload = pendingList.map(({ txHash }) => ({ tx_hash: txHash }));
    const listener = lightGodwoken?.subscribPendingDepositTransactions(subscribePayload);
    if (listener) {
      listener.on("success", (txHash) => {
        updateTxWithStatus(txHash, "success");
      });
      listener.on("fail", (e) => {
        if (e instanceof DepositRejectedError) {
          updateTxWithStatus(e.metadata, "rejected");
        } else if (e instanceof LightGodwokenError) {
          updateTxWithStatus(e.metadata, "fail");
        }
      });
      listener.on("pending", (txHash) => {
        updateTxWithStatus(txHash, "pending");
      });
      setDepositListListener(listener);
    }

    setCKBInput("");
    setSudtInputValue("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightGodwoken, godwokenVersion, depositHistory]);

  useMemo(() => {
    setCKBInput("");
    setSudtInputValue("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightGodwoken, godwokenVersion, ethAddress]);

  useEffect(() => {
    return function cleanup() {
      depositListListener.removeAllListeners();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightGodwoken, godwokenVersion, depositHistory]);

  const handleError = (e: unknown, selectedSudt?: SUDT) => {
    console.error(e);
    if (e instanceof NotEnoughCapacityError) {
      const expect = formatToThousands(getFullDisplayAmount(BI.from(e.metadata.expected), 8, { maxDecimalPlace: 8 }));
      const actual = formatToThousands(getFullDisplayAmount(BI.from(e.metadata.actual), 8, { maxDecimalPlace: 8 }));
      notification.error({
        message: `You need to get more ckb for deposit, cause there is ${expect} CKB expected but only got ${actual} CKB`,
      });
      return;
    }
    if (e instanceof NotEnoughSudtError) {
      const expect = formatToThousands(
        getFullDisplayAmount(BI.from(e.metadata.expected), selectedSudt?.decimals, {
          maxDecimalPlace: selectedSudt?.decimals,
        }),
      );
      const actual = formatToThousands(
        getFullDisplayAmount(BI.from(e.metadata.actual), selectedSudt?.decimals, {
          maxDecimalPlace: selectedSudt?.decimals,
        }),
      );
      notification.error({
        message: `You need to get more ${selectedSudt?.symbol} for deposit, cause there is ${expect} ${selectedSudt?.symbol} expected but only got ${actual} ${selectedSudt?.symbol}`,
      });
      return;
    }
    if (e instanceof TransactionSignError) {
      notification.error({
        message: `User cancelled sign in metamask, please try again.`,
      });
      return;
    }
    captureException(e);
    notification.error({
      message: `Unknown Error, Please try again later`,
    });
  };
  const deposit = async () => {
    if (!lightGodwoken) {
      throw new Error("LightGodwoken not found");
    }
    const capacity = parseStringToBI(CKBInput, 8).toHexString();
    let amount = "0x0";
    if (selectedSudt && sudtInput) {
      amount = parseStringToBI(sudtInput, selectedSudt.decimals).toHexString();
    }
    setIsModalVisible(true);
    try {
      const txHash = await lightGodwoken.deposit({
        capacity: capacity,
        amount: amount,
        sudtType: selectedSudt?.type,
      });
      addTxToHistory({
        txHash: txHash,
        capacity,
        amount,
        token: selectedSudt,
        status: "pending",
        date: format(new Date(), "yyyy-MM-dd HH:mm:ss"),
        cancelTimeout,
      });
      setIsModalVisible(false);
    } catch (e) {
      handleError(e, selectedSudt);
      setIsModalVisible(false);
      return;
    }
  };

  const inputError = useMemo(() => {
    return getDepositInputError({
      CKBInput,
      CKBBalance,
      sudtValue: sudtInput,
      sudtBalance: selectedSudtBalance,
      sudtDecimals: selectedSudt?.decimals,
      sudtSymbol: selectedSudt?.symbol,
    });
  }, [CKBInput, CKBBalance, sudtInput, selectedSudtBalance, selectedSudt?.decimals, selectedSudt?.symbol]);

  const handleCancel = () => {
    setIsModalVisible(false);
  };

  useEffect(() => {
    setIsCKBValueValidate(isDepositCKBInputValidate(CKBInput, CKBBalance));
  }, [CKBBalance, CKBInput]);

  useEffect(() => {
    setIsSudtValueValidate(isSudtInputValidate(sudtInput, selectedSudtBalance, selectedSudt?.decimals));
  }, [sudtInput, selectedSudtBalance, selectedSudt?.decimals]);

  const handleSelectedChange = (value: Token, balance: string) => {
    setSelectedSudt(value as SUDT);
    setSelectedSudtBalance(balance);
  };

  return (
    <>
      <Card>
        <WalletConnect></WalletConnect>
        <div style={{ opacity: lightGodwoken ? "1" : "0.5" }}>
          <Form
            labelCol={{ span: 8 }}
            wrapperCol={{ span: 12 }}
            layout="horizontal"
          >
            <Form.Item label="Axon Address" style={{fontWeight: 600}}>
              <Input style={{padding: '4px'}} bordered={false} readOnly={true} value={ethAddress ? truncateMiddle(ethAddress, 11, 11) : ''} suffix={
                <Tooltip title="Copy Axon Address">
                  <CopyIcon style={{ color: 'rgba(0,0,0,.45)' }} onClick={copyAddress}/>
                </Tooltip>
              }/>
            </Form.Item>
            <Form.Item label="wCKB fee" style={{fontWeight: 600}}>
              <Input style={{padding: '4px'}} bordered={false} readOnly={true} value={ethAddress ? truncateMiddle(ethAddress, 11, 11) : ''} suffix={
                <Tooltip title="Copy Axon Address">
                  <CopyIcon style={{ color: 'rgba(0,0,0,.45)' }} onClick={copyAddress}/>
                </Tooltip>
              }/>
            </Form.Item>
          </Form>
          <BridgeWalletInfo
            ckbAddress={ckbAddress}
            ckbBalance={CKBBalance}
            ethAddress={ethAddress}
            ethBalance={l2CKBBalance}
          ></BridgeWalletInfo>
          <BridgeFeeShow
            value={CKBInput}
            onUserInput={setCKBInput}
            label="CkbToAxon"
            isLoading={CKBBalanceQuery.isLoading}
            CKBBalance={CKBBalance}
            maxAmount={maxAmount}
          ></BridgeFeeShow>
          <CKBInputPanel
            value={CKBInput}
            onUserInput={setCKBInput}
            label="Deposit"
            isLoading={CKBBalanceQuery.isLoading}
            CKBBalance={CKBBalance}
            maxAmount={maxAmount}
          ></CKBInputPanel>
          <PlusIconContainer>
            <PlusIcon />
          </PlusIconContainer>
          <CurrencyInputPanel
            value={sudtInput}
            onUserInput={setSudtInputValue}
            label="sUDT(optional)"
            onSelectedChange={handleSelectedChange}
            balancesList={sudtBalanceQUery.data?.balances}
            tokenList={tokenList}
            dataLoading={sudtBalanceQUery.isLoading}
          ></CurrencyInputPanel>
          <PrimaryButton disabled={!CKBInput || !isCKBValueValidate || !isSudtValueValidate} onClick={deposit}>
            {inputError || "Deposit"}
          </PrimaryButton>
        </div>
      </Card>
      <Card>
        <DepositList depositHistory={depositHistoryFilteredByCancelTimeout} isLoading={depositListLoading} />
      </Card>
      <ConfirmModal
        title="Confirm Transaction"
        visible={isModalVisible}
        onCancel={handleCancel}
        footer={null}
        width={400}
      >
        <ModalContent>
          <InputInfo>
            <span className="title">Depositing</span>
            <div className="amount">
              <div className="ckb-amount">
                <MainText>{formatToThousands(CKBInput)}</MainText>
                <div className="ckb-icon">
                  <CKBIcon></CKBIcon>
                </div>
                <MainText>CKB</MainText>
              </div>
              {sudtInput && (
                <div className="sudt-amount">
                  <MainText>{formatToThousands(sudtInput)}</MainText>
                  {selectedSudt?.tokenURI ? <img src={selectedSudt?.tokenURI} alt="" /> : ""}
                  <MainText>{selectedSudt?.symbol}</MainText>
                </div>
              )}
            </div>
          </InputInfo>

          <LoadingWrapper>
            <LoadingOutlined />
          </LoadingWrapper>
          <Tips>Waiting for User Confirmation</Tips>
        </ModalContent>
      </ConfirmModal>
    </>
  );
}
