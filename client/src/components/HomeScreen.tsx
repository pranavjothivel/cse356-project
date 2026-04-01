import { useState, useEffect, useContext } from "react";
import { useNavigate } from "react-router-dom";

import AuthContext from "../auth";

import ProfileModal from "./ProfileModal";

export default function HomeScreen() {
    const { auth } = useContext(AuthContext);
    const navigate = useNavigate();

    const [modal, setModal] = useState("");

    useEffect(() => {
        //console.log(auth.loggedIn);
        if (auth.loggedIn == false) {
            navigate("/login", { replace: true });
        }
    }, [auth.loggedIn]);

    const logout = () => {
        auth.logout();
    }

    const changeModal = (newModal: string) => {
        setModal(newModal);
    }

    let modalContent: any = "";
    if (modal == "profile") {
        modalContent = <ProfileModal closeCallback={() => {changeModal("")}}/>;
    }

    return (
        <div className="screen">
            <div style={{display: "flex"}}>
                <div className="cursorPtr" onClick={() => {changeModal("profile")}}>Profile</div>
                <div className="cursorPtr" style={{marginLeft: "16px"}} onClick={logout}>Logout</div>
            </div>
            {
                modalContent
            }
        </div>
    )
}